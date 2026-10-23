'use strict';

/**
 * Data access for `invoices` + the `invoice_counters` numbering mechanism —
 * parameterized SQL only (C-04). The mutating helpers run on the SERVICE's
 * transaction client so invoice creation commits/rolls back together with the
 * order's `shipped` transition (the stock consumption + ledger + audit + invoice
 * are ONE atomic unit — FR-INV-01 / NFR-06).
 *
 * IDEMPOTENCY (FR-INV-05 / AC-INV-03): `invoices.order_id` is UNIQUE, so the
 * insert uses `ON CONFLICT (order_id) DO NOTHING` — a retried/duplicate ship
 * (or any buggy double call) simply returns no row instead of raising a second
 * invoice. The counter row is still advanced atomically via upsert-RETURNING.
 *
 * OWNERSHIP (FR-INV-04): every read joins `orders` so a customer can only ever
 * resolve invoices whose order belongs to them; a foreign invoice is not
 * returned (→ 404, never 403 — no existence leak, mirroring FR-ORD-11).
 */

const { query } = require('../db/pool');

function executor(client) {
  return client || { query: (sql, args) => query(sql, args) };
}

// ── Numbering (D-10 / FR-INV-02) ─────────────────────────────────────────────

/**
 * Claim the next sequence value for a period ('YYYY') atomically. Runs on the
 * caller's transaction client; the row lock taken by the upsert serialises
 * concurrent claims without advisory locks and is gap-tolerant.
 */
async function claimNextNumber(client, period) {
  const r = await client.query(
    `INSERT INTO invoice_counters (period, next_val)
     VALUES ($1, 1)
     ON CONFLICT (period) DO UPDATE SET next_val = invoice_counters.next_val + 1
     RETURNING next_val`,
    [period]
  );
  return Number(r.rows[0].next_val);
}

// ── Write ────────────────────────────────────────────────────────────────────

const INVOICE_RETURN = `id, order_id, invoice_number, issued_by,
  to_char(issued_date, 'YYYY-MM-DD') AS issued_date,
  subtotal, tax_total, grand_total, status, void_reason, voided_at`;

/**
 * Insert an invoice for an order, idempotent on order_id. Returns the invoice
 * row, or null when one already exists for the order (a duplicate/replay).
 */
async function insertInvoice(
  client,
  { orderId, invoiceNumber, issuedBy, subtotal, taxTotal, grandTotal, issuedDate }
) {
  const r = await client.query(
    `INSERT INTO invoices
       (order_id, invoice_number, issued_by, issued_date, status, subtotal, tax_total, grand_total)
     VALUES ($1, $2, $3, COALESCE($4::date, current_date), 'issued', $5, $6, $7)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING ${INVOICE_RETURN}`,
    [orderId, invoiceNumber, issuedBy, issuedDate || null, subtotal, taxTotal, grandTotal]
  );
  return r.rows[0] ? mapInvoice(r.rows[0]) : null;
}

/** Staff annulment — flips status to voided but NEVER deletes the row/totals. */
async function voidInvoice(client, invoiceId, reason) {
  const r = await client.query(
    `UPDATE invoices
        SET status = 'voided', void_reason = $2, voided_at = now()
      WHERE id = $1 AND status = 'issued'
      RETURNING ${INVOICE_RETURN}`,
    [invoiceId, reason]
  );
  return r.rows[0] ? mapInvoice(r.rows[0]) : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Invoice columns plus the owning order + customer, always via the orders join
// so customer scoping is enforced at the row level.
const INVOICE_JOIN = `
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN users cu ON cu.id = o.customer_id`;

function invoiceSelect(aliases) {
  return `
    i.id, i.order_id, i.invoice_number, i.issued_by,
    to_char(i.issued_date, 'YYYY-MM-DD') AS issued_date,
    i.subtotal, i.tax_total, i.grand_total, i.status, i.void_reason, i.voided_at,
    o.customer_id, o.status AS order_status, o.created_at AS order_created_at,
    cu.name AS customer_name, cu.email AS customer_email${aliases || ''}`;
}

function mapInvoice(row) {
  return {
    id: String(row.id),
    order_id: String(row.order_id),
    invoice_number: row.invoice_number,
    issued_by: row.issued_by === null || row.issued_by === undefined ? null : String(row.issued_by),
    issued_date: row.issued_date,
    subtotal: row.subtotal, // NUMERIC → string
    tax_total: row.tax_total,
    grand_total: row.grand_total,
    status: row.status,
    void_reason: row.void_reason,
    voided_at: row.voided_at,
    customer_id:
      row.customer_id === null || row.customer_id === undefined ? null : String(row.customer_id),
    order_status: row.order_status,
    order_created_at: row.order_created_at,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
  };
}

/**
 * Load one invoice by id, optionally restricted to an owning customer (the
 * customer's own id). A foreign id simply returns null → service 404s.
 */
async function findInvoice(invoiceId, { customerId = null } = {}, client = null) {
  const params = [invoiceId];
  let scope = '';
  if (customerId !== null) {
    params.push(customerId);
    scope = ` AND o.customer_id = $2`;
  }
  const r = await executor(client).query(
    `SELECT ${invoiceSelect()} ${INVOICE_JOIN} WHERE i.id = $1${scope}`,
    params
  );
  return r.rows[0] ? mapInvoice(r.rows[0]) : null;
}

/** Load an invoice by its order id, same ownership scoping. */
async function findInvoiceByOrderId(orderId, { customerId = null } = {}, client = null) {
  const params = [orderId];
  let scope = '';
  if (customerId !== null) {
    params.push(customerId);
    scope = ` AND o.customer_id = $2`;
  }
  const r = await executor(client).query(
    `SELECT ${invoiceSelect()} ${INVOICE_JOIN} WHERE i.order_id = $1${scope}`,
    params
  );
  return r.rows[0] ? mapInvoice(r.rows[0]) : null;
}

/**
 * Paginated invoice list. `customerId` restricts to one owner (customers); staff
 * pass null to see all, optionally filtered by invoice status. Newest first.
 */
async function listInvoices({ customerId = null, status = null, page, limit }) {
  const clauses = [];
  const args = [];
  if (customerId !== null) {
    args.push(customerId);
    clauses.push(`o.customer_id = $${args.length}`);
  }
  if (status) {
    args.push(status);
    clauses.push(`i.status = $${args.length}`);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countRes = await query(`SELECT count(*)::int AS total ${INVOICE_JOIN} ${whereSql}`, args);
  const total = countRes.rows[0].total;

  const dataArgs = args.concat([limit, (page - 1) * limit]);
  const dataRes = await query(
    `SELECT ${invoiceSelect()} ${INVOICE_JOIN} ${whereSql}
      ORDER BY i.issued_date DESC, i.id DESC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    dataArgs
  );
  return { rows: dataRes.rows.map(mapInvoice), total };
}

module.exports = {
  claimNextNumber,
  insertInvoice,
  voidInvoice,
  findInvoice,
  findInvoiceByOrderId,
  listInvoices,
  mapInvoice,
};
