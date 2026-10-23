'use strict';

const { withTransaction } = require('../db/pool');
const invoiceRepo = require('../repositories/invoice.repository');
const orderRepo = require('../repositories/order.repository');
const { logAudit } = require('./audit.service');
const { ApiError } = require('../utils/errors');
const { ROLE_VALUES } = require('../constants/roles');
const {
  formatInvoiceNumber,
  counterPeriodForYear,
  canVoid,
  INVOICE_STATUS,
  INVOICE_DEMO_NOTICE,
  DISTRIBUTOR,
} = require('../constants/invoices');
const {
  invoiceIdParamSchema,
  invoiceListQuerySchema,
  voidInvoiceSchema,
  orderIdParamSchema,
  validateInput,
} = require('../utils/validators');

/**
 * Invoice domain logic (FR-INV-01..05). An invoice is the financial document of
 * a SHIPPED order: it is minted inside the very transaction that consumes stock
 * (see order.service.updateStatus), so it can never exist for an order that did
 * not actually ship, and never twice for one that did.
 *
 *  - Money comes ONLY from the ORDER's persisted snapshot (order.subtotal /
 *    tax_total / grand_total) — never recomputed from the live catalog and never
 *    from a client body (D-07 / AC-INV-01). `grand = subtotal + tax` is also a
 *    DB CHECK, so a mismatched invoice cannot be committed.
 *  - The number is drawn from a per-YEAR counter atomically inside the same
 *    transaction (FR-INV-02 / D-10).
 *  - Creation is idempotent: `invoices.order_id` is UNIQUE, so a duplicate ship
 *    resolves to the existing invoice instead of minting a second one
 *    (FR-INV-05 / AC-INV-03).
 */

/** Build the customer-facing printable payload (lines + branding + demo label). */
function presentInvoice(invoice, items) {
  return {
    id: invoice.id,
    invoice_number: invoice.invoice_number,
    order_id: invoice.order_id,
    order_status: invoice.order_status,
    status: invoice.status,
    issued_date: invoice.issued_date,
    issued_by: invoice.issued_by,
    void_reason: invoice.void_reason,
    voided_at: invoice.voided_at,
    subtotal: invoice.subtotal,
    tax_total: invoice.tax_total,
    grand_total: invoice.grand_total,
    customer: {
      id: invoice.customer_id,
      name: invoice.customer_name,
      email: invoice.customer_email,
    },
    items,
    distributor: DISTRIBUTOR,
    document_kind: 'invoice',
    demo: true,
    demo_notice: INVOICE_DEMO_NOTICE,
  };
}

/**
 * Mint the invoice for a just-shipped order. MUST be called on the caller's
 * transaction client (the order's `→ shipped` transaction) so invoice creation
 * is atomic with stock consumption. Idempotent: returns the existing invoice
 * (created:false) if one is already present for the order.
 */
async function generateForOrder(client, order, actor) {
  const issuedDate = new Date();
  const year = issuedDate.getUTCFullYear();
  const period = counterPeriodForYear(year);

  const existing = await invoiceRepo.findInvoiceByOrderId(order.id, {}, client);
  if (existing) return { invoice: existing, created: false };

  const seq = await invoiceRepo.claimNextNumber(client, period);
  const invoiceNumber = formatInvoiceNumber(year, seq);

  const invoice = await invoiceRepo.insertInvoice(client, {
    orderId: order.id,
    invoiceNumber,
    issuedBy: actor.id,
    subtotal: order.subtotal, // the order's persisted snapshot — not recomputed
    taxTotal: order.tax_total,
    grandTotal: order.grand_total,
    issuedDate: issuedDate.toISOString().slice(0, 10),
  });

  if (!invoice) {
    // Lost a race to a concurrent ship for the same order: replay the winner.
    const winner = await invoiceRepo.findInvoiceByOrderId(order.id, {}, client);
    return { invoice: winner, created: false };
  }

  await logAudit(client, {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'INVOICE_ISSUED',
    entityType: 'invoice',
    entityId: invoice.id,
    details: {
      order_id: order.id,
      invoice_number: invoiceNumber,
      grand_total: invoice.grand_total,
    },
  });

  return { invoice, created: true };
}

/** GET /api/invoices — customer (own) / staff (all). */
async function listInvoices(user, rawQuery) {
  const query = validateInput(invoiceListQuerySchema, rawQuery);
  const isCustomer = user.role === ROLE_VALUES.CUSTOMER;
  const customerId = isCustomer ? user.id : (query.customer_id ?? null);
  const { rows, total } = await invoiceRepo.listInvoices({
    customerId,
    status: query.status ?? null,
    page: query.page,
    limit: query.limit,
  });
  return { data: rows, meta: { page: query.page, limit: query.limit, total } };
}

/** GET /api/invoices/:id — full printable payload; ownership enforced; 404 not 403. */
async function getInvoice(user, rawInvoiceId) {
  const { id: invoiceId } = validateInput(invoiceIdParamSchema, { id: rawInvoiceId });
  const isCustomer = user.role === ROLE_VALUES.CUSTOMER;
  const invoice = await invoiceRepo.findInvoice(invoiceId, {
    customerId: isCustomer ? user.id : null,
  });
  if (!invoice) throw new ApiError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  const items = await orderRepo.findItems(invoice.order_id);
  return presentInvoice(invoice, items);
}

/** GET /api/orders/:id/invoice — the invoice for an order (convenience route). */
async function getInvoiceByOrder(user, rawOrderId) {
  const { id: orderId } = validateInput(orderIdParamSchema, { id: rawOrderId });
  const isCustomer = user.role === ROLE_VALUES.CUSTOMER;
  const invoice = await invoiceRepo.findInvoiceByOrderId(orderId, {
    customerId: isCustomer ? user.id : null,
  });
  if (!invoice) {
    throw new ApiError(404, 'INVOICE_NOT_FOUND', 'No invoice for this order');
  }
  const items = await orderRepo.findItems(invoice.order_id);
  return presentInvoice(invoice, items);
}

/** POST /api/invoices/:id/void — staff only; preserves the row, flips status, audits. */
async function voidInvoice(user, rawInvoiceId, rawBody) {
  const { id: invoiceId } = validateInput(invoiceIdParamSchema, { id: rawInvoiceId });
  const { reason } = validateInput(voidInvoiceSchema, rawBody);

  const current = await invoiceRepo.findInvoice(invoiceId);
  if (!current) throw new ApiError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  if (!canVoid(current.status)) {
    throw ApiError.conflict(
      'INVALID_STATE_TRANSITION',
      `Invoice is already '${current.status}' and cannot be voided again`,
      { from: current.status }
    );
  }

  // The status flip + its audit row commit together; the UPDATE is guarded on
  // status='issued' so a concurrent void loses and surfaces as a conflict.
  const updated = await withTransaction(async (client) => {
    const row = await invoiceRepo.voidInvoice(client, invoiceId, reason);
    if (!row) {
      throw ApiError.conflict('INVALID_STATE_TRANSITION', 'Invoice is already voided', {
        from: INVOICE_STATUS.VOIDED,
      });
    }
    await logAudit(client, {
      actorId: user.id,
      actorRole: user.role,
      action: 'INVOICE_VOIDED',
      entityType: 'invoice',
      entityId: row.id,
      details: { invoice_number: row.invoice_number, reason },
    });
    return row;
  });

  const items = await orderRepo.findItems(updated.order_id);
  return presentInvoice(updated, items);
}

module.exports = {
  generateForOrder,
  listInvoices,
  getInvoice,
  getInvoiceByOrder,
  voidInvoice,
  presentInvoice,
};
