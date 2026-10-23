'use strict';

const crypto = require('node:crypto');

const { withTransaction } = require('../db/pool');
const orderRepo = require('../repositories/order.repository');
const cartRepo = require('../repositories/cart.repository');
const invoiceService = require('./invoice.service');
const { logAudit } = require('./audit.service');
const money = require('../utils/money');
const { ApiError } = require('../utils/errors');
const { ROLE_VALUES } = require('../constants/roles');
const { CART_MAX_LINE_QTY } = require('../constants/cart');
const {
  ORDER_STATUS,
  CONSUMPTION_STATUS,
  isLegalForward,
  isCancellable,
} = require('../constants/orders');
const {
  createOrderSchema,
  orderIdParamSchema,
  orderListQuerySchema,
  updateOrderStatusSchema,
  cancelOrderSchema,
  validateInput,
} = require('../utils/validators');

/**
 * Order domain logic (FR-ORD-01..11). The hardest module: it must be
 * transaction-atomic, concurrency-safe against overselling (risk R-01), money-
 * exact (D-09), idempotent (D-08) and role-correct (D-05).
 *
 *  - The customer is ALWAYS the authenticated user id, never a client field.
 *  - Prices/totals are recomputed server-side from the live catalog; a client
 *    body may carry only product ids + quantities.
 *  - Stock is reserved (not consumed) on create under `SELECT … FOR UPDATE`
 *    row locks taken in a consistent product-id order; the reservation is
 *    consumed exactly once at SHIPMENT and released exactly once on
 *    CANCELLATION (which is only legal before shipment) — so a unit can never
 *    be deducted twice.
 */

/** Stable SHA-256 fingerprint of the normalized requested lines (idempotency matching). */
function fingerprint(lines) {
  const normalized = [...lines]
    .map((l) => ({ product_id: Number(l.product_id), quantity: Number(l.quantity) }))
    .sort((a, b) => a.product_id - b.product_id);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Merge duplicate product ids into a single line (order_items is UNIQUE per product). */
function mergeLines(lines) {
  const byProduct = new Map();
  for (const l of lines) {
    const pid = Number(l.product_id);
    byProduct.set(pid, (byProduct.get(pid) || 0) + Number(l.quantity));
  }
  return [...byProduct.entries()]
    .map(([product_id, quantity]) => ({ product_id, quantity }))
    .sort((a, b) => a.product_id - b.product_id);
}

function serialize(order, items) {
  return { ...order, items };
}

/**
 * The atomic order-creation work + idempotency completion. Runs the whole
 * stock/order/ledger/audit/cart write in ONE transaction (rollback on any
 * failure); only after commit does it store the response on the claim row so a
 * retry replays it instead of double-charging.
 */
async function runCreate(claimId, customerId, requested, actor) {
  let result;
  try {
    result = await withTransaction(async (client) => {
      // Rows are locked ONE PRODUCT AT A TIME in ascending id order — the same
      // global order for every request — to serialize oversells without deadlock.
      const lines = [];
      const offenders = [];
      for (const req of requested) {
        const inv = await orderRepo.lockInventory(client, req.product_id);
        const product = await orderRepo.loadProduct(client, req.product_id);
        if (!product || !product.is_active) {
          // Unknown or deactivated → not orderable (FR-CAT-08). 404 does not
          // leak which archived ids exist.
          throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'One or more products are unavailable');
        }
        const available = inv ? inv.available_quantity : 0;
        if (!inv || req.quantity > available) {
          offenders.push({
            product_id: String(product.id),
            product_name: product.name,
            requested: req.quantity,
            available,
          });
          continue;
        }
        const computed = money.computeLine({
          unit_price: product.unit_price,
          tax_rate: product.tax_rate,
          quantity: req.quantity,
        });
        lines.push({
          product_id: product.id,
          product_name: product.name,
          unit_price: computed.unit_price,
          tax_rate: product.tax_rate,
          quantity: req.quantity,
          line_total: computed.line_total,
          line_tax: computed.line_tax,
          _lineTotalCents: computed._lineTotalCents,
          _lineTaxCents: computed._lineTaxCents,
        });
      }

      // Any shortfall aborts the ENTIRE order before we write anything (FR-ORD-03).
      if (offenders.length) {
        throw ApiError.conflict(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for ${offenders.length} item(s)`,
          { items: offenders }
        );
      }

      const summary = money.summarize(lines); // invariant grand = subtotal + tax
      const order = await orderRepo.insertOrder(client, {
        customerId,
        subtotal: summary.subtotal,
        taxTotal: summary.tax_total,
        grandTotal: summary.grand_total,
      });
      await orderRepo.insertOrderItems(client, order.id, summary.lines);

      for (const line of lines) {
        await orderRepo.reserveStock(client, {
          productId: line.product_id,
          quantity: line.quantity,
          orderId: order.id,
          performedBy: actor.id,
        });
      }

      await orderRepo.emptyCart(client, customerId); // FR-CART-05
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'ORDER_CREATED',
        entityType: 'order',
        entityId: order.id,
        details: { item_count: lines.length, grand_total: summary.grand_total },
      });
      // The reservation is a distinct, security-relevant stock event (Phase 9):
      // audited in the SAME transaction so the trail shows units were held for
      // this order. Kept minimal — product ids + quantities, no prices/PII.
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'STOCK_RESERVED',
        entityType: 'order',
        entityId: order.id,
        details: {
          line_count: lines.length,
          lines: lines.map((l) => ({ product_id: String(l.product_id), quantity: l.quantity })),
        },
      });

      const items = await orderRepo.findItems(order.id, client);
      return serialize(order, items);
    });
  } catch (err) {
    // Rollback already happened; free the key so the same request can be retried.
    await orderRepo.failClaim(claimId).catch(() => {});
    throw err;
  }

  await withTransaction((client) => orderRepo.completeClaim(client, claimId, 201, result));
  return { replay: false, status: 201, body: result };
}

// summarize() strips the internal *_cents fields but keeps every business column
// (product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax),
// which is exactly what insertOrderItems reads — so summary.lines is used directly.

/** POST /api/orders — customer. Idempotent, atomic, server-priced. */
async function createOrder(customerId, rawBody, actor, idempotencyKey) {
  const body = validateInput(createOrderSchema, rawBody || {});

  // Resolve requested lines: explicit items[] or, when absent, the caller's cart.
  let requested;
  if (body.items) {
    requested = body.items;
  } else {
    const cartLines = await cartRepo.findLines(customerId);
    requested = cartLines.map((l) => ({ product_id: Number(l.product_id), quantity: l.quantity }));
  }
  requested = mergeLines(requested);
  if (requested.length === 0) {
    throw new ApiError(422, 'EMPTY_CART', 'Your cart is empty');
  }
  for (const line of requested) {
    if (line.quantity > CART_MAX_LINE_QTY) {
      throw ApiError.badRequest(`A single order line cannot exceed ${CART_MAX_LINE_QTY} units`, {
        product_id: String(line.product_id),
        quantity: line.quantity,
        max: CART_MAX_LINE_QTY,
      });
    }
  }

  const scope = 'POST /api/orders';
  const hash = fingerprint(requested);

  // Claim the key in its OWN committed transaction, before touching stock (R-04).
  const claim = await withTransaction((client) =>
    orderRepo.claimKey(client, { userId: customerId, idempotencyKey, scope, requestHash: hash })
  );

  if (claim.existing) {
    const row = claim.existing;
    if (row.status === 'completed') {
      if (row.request_hash !== hash) {
        throw ApiError.conflict(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key has already been used for a different request'
        );
      }
      return { replay: true, status: row.response_status, body: row.response_body };
    }
    if (row.status === 'in_progress') {
      throw ApiError.conflict(
        'DUPLICATE_REQUEST',
        'A request with this idempotency key is already in progress'
      );
    }
    // 'failed' → reopen and retry.
    await withTransaction((client) => orderRepo.retakeClaim(client, row.id, hash));
    return runCreate(row.id, customerId, requested, actor);
  }
  if (!claim.claimed) {
    throw ApiError.conflict(
      'DUPLICATE_REQUEST',
      'A request with this idempotency key is already in progress'
    );
  }
  return runCreate(claim.claimId, customerId, requested, actor);
}

/** GET /api/orders — customer sees only their own; staff see all. */
async function listOrders(user, rawQuery) {
  const query = validateInput(orderListQuerySchema, rawQuery);
  const isCustomer = user.role === ROLE_VALUES.CUSTOMER;
  const customerId = isCustomer ? user.id : (query.customer_id ?? null);
  const { rows, total } = await orderRepo.listOrders({
    customerId,
    status: query.status ?? null,
    page: query.page,
    limit: query.limit,
  });
  return { data: rows, meta: { page: query.page, limit: query.limit, total } };
}

/** GET /api/orders/:id (+ /items) — ownership enforced; foreign → 404 (FR-ORD-11). */
async function getOrder(user, rawOrderId) {
  const { id: orderId } = validateInput(orderIdParamSchema, { id: rawOrderId });
  const isCustomer = user.role === ROLE_VALUES.CUSTOMER;
  const order = await orderRepo.findOrder(orderId, {
    customerId: isCustomer ? user.id : null,
  });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const items = await orderRepo.findItems(order.id);
  return serialize(order, items);
}

async function getOrderItems(user, rawOrderId) {
  const order = await getOrder(user, rawOrderId); // access check + load first
  return orderRepo.findItems(order.id);
}

/** PATCH /api/orders/:id/status — staff only; forward transitions only. */
async function updateStatus(user, rawOrderId, rawBody) {
  const { id: orderId } = validateInput(orderIdParamSchema, { id: rawOrderId });
  const { status: target } = validateInput(updateOrderStatusSchema, rawBody);
  if (target === ORDER_STATUS.CANCELLED) {
    throw ApiError.conflict(
      'INVALID_STATE_TRANSITION',
      'Cancellation is a separate operation — use POST /api/orders/:id/cancel'
    );
  }

  return withTransaction(async (client) => {
    // Lock the order row FIRST so concurrent transitions of this same order
    // serialize (one ship, or one cancel — never both, never twice).
    const order = await orderRepo.lockOrder(client, orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (!isLegalForward(order.status, target)) {
      throw ApiError.conflict(
        'INVALID_STATE_TRANSITION',
        `Cannot move ${order.status} → ${target}`,
        {
          from: order.status,
          to: target,
        }
      );
    }

    if (target === CONSUMPTION_STATUS) {
      // Convert reservations into fulfilled (consumed) stock EXACTLY ONCE:
      // physical -= qty AND reserved -= qty, locked in consistent product order.
      const items = await orderRepo.findItems(order.id, client);
      const sorted = [...items].sort((a, b) => Number(a.product_id) - Number(b.product_id));
      for (const item of sorted) {
        const inv = await orderRepo.lockInventory(client, item.product_id);
        if (!inv || inv.reserved_quantity < item.quantity) {
          throw ApiError.conflict(
            'INVALID_STATE_TRANSITION',
            `Reservation for product ${item.product_id} is no longer intact`,
            { product_id: item.product_id }
          );
        }
        await orderRepo.consumeStock(client, {
          productId: item.product_id,
          quantity: item.quantity,
          orderId: order.id,
          performedBy: user.id,
        });
      }
      // Consumption (physical stock physically leaves) is its own audited event.
      await logAudit(client, {
        actorId: user.id,
        actorRole: user.role,
        action: 'STOCK_CONSUMED',
        entityType: 'order',
        entityId: order.id,
        details: {
          line_count: sorted.length,
          lines: sorted.map((l) => ({ product_id: String(l.product_id), quantity: l.quantity })),
        },
      });
    }

    const updated = await orderRepo.updateStatus(client, order.id, target);
    await logAudit(client, {
      actorId: user.id,
      actorRole: user.role,
      action: 'ORDER_STATUS_CHANGED',
      entityType: 'order',
      entityId: order.id,
      details: { from: order.status, to: target },
    });

    // Reaching the consumption point (ship) is fulfillment: mint the invoice in
    // the SAME transaction, from the order's persisted snapshot (FR-INV-01). The
    // ship itself is a one-time legal transition and invoices.order_id is UNIQUE,
    // so invoicing is idempotent — a replay never doubles the document (FR-INV-05).
    if (target === CONSUMPTION_STATUS) {
      await invoiceService.generateForOrder(client, updated, { id: user.id, role: user.role });
    }

    const items = await orderRepo.findItems(order.id, client);
    return serialize(updated, items);
  });
}

/** POST /api/orders/:id/cancel — distinct operation; releases the reservation once. */
async function cancelOrder(user, rawOrderId, rawBody) {
  const { id: orderId } = validateInput(orderIdParamSchema, { id: rawOrderId });
  const { reason } = validateInput(cancelOrderSchema, rawBody);
  const isCustomer = user.role === ROLE_VALUES.CUSTOMER;

  return withTransaction(async (client) => {
    // Lock the order row FIRST (same serialization as updateStatus), and
    // scoped: customers can only reach their own order; a foreign id is 404.
    const order = await orderRepo.lockOrder(client, orderId, {
      customerId: isCustomer ? user.id : null,
    });
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (!isCancellable(order.status)) {
      throw ApiError.conflict(
        'INVALID_STATE_TRANSITION',
        `An order in '${order.status}' status cannot be cancelled`,
        { from: order.status }
      );
    }

    // Release reserved stock — the order is still pre-shipment, so the
    // reservation is intact and is given back exactly once here.
    const items = await orderRepo.findItems(order.id, client);
    const sorted = [...items].sort((a, b) => Number(a.product_id) - Number(b.product_id));
    for (const item of sorted) {
      const inv = await orderRepo.lockInventory(client, item.product_id);
      if (!inv || inv.reserved_quantity < item.quantity) {
        throw ApiError.conflict(
          'INVALID_STATE_TRANSITION',
          `Reservation for product ${item.product_id} is no longer intact`,
          { product_id: item.product_id }
        );
      }
      await orderRepo.releaseReservation(client, {
        productId: item.product_id,
        quantity: item.quantity,
        orderId: order.id,
        performedBy: user.id,
      });
    }
    // Releasing a reservation back to sellable stock is its own audited event.
    await logAudit(client, {
      actorId: user.id,
      actorRole: user.role,
      action: 'STOCK_RELEASED',
      entityType: 'order',
      entityId: order.id,
      details: {
        line_count: sorted.length,
        lines: sorted.map((l) => ({ product_id: String(l.product_id), quantity: l.quantity })),
      },
    });

    const updated = await orderRepo.updateStatus(client, order.id, ORDER_STATUS.CANCELLED, reason);
    await logAudit(client, {
      actorId: user.id,
      actorRole: user.role,
      action: 'ORDER_CANCELLED',
      entityType: 'order',
      entityId: order.id,
      details: { reason },
    });
    const itemsAfter = await orderRepo.findItems(order.id, client);
    return serialize(updated, itemsAfter);
  });
}

module.exports = {
  createOrder,
  listOrders,
  getOrder,
  getOrderItems,
  updateStatus,
  cancelOrder,
  serialize,
  fingerprint,
  mergeLines,
};
