'use strict';

/**
 * Data access for `orders`, `order_items`, and the ordering side of
 * `inventory` + `inventory_movements` + `idempotency_keys` — parameterized SQL
 * only (C-04). Every mutating helper runs on a TRANSACTION client supplied by
 * the service, so the whole order write (order + items + stock + ledger + audit
 * + cart clear) commits or rolls back atomically (FR-ORD-02 / NFR-06).
 *
 * CONCURRENCY (risk R-01 / AC-ORD-05): inventory rows are locked with
 * `SELECT … FOR UPDATE` ONE PRODUCT AT A TIME in ascending product-id order, so
 * concurrent orders always acquire the row locks in the same global sequence and
 * cannot deadlock; the reservation/available CHECKs are the final guard so a
 * buggy service still cannot commit an oversold state. The service never trusts
 * a prior cart/front-end stock check — it re-reads availability here.
 *
 * OWNERSHIP: order reads are scoped by `customer_id` for customers; a foreign
 * order simply isn't returned (→ 404, never 403 — no existence leak, FR-ORD-11).
 */

const { query } = require('../db/pool');

function executor(client) {
  return client || { query: (sql, args) => query(sql, args) };
}

// ── Idempotency claim (D-08 / FR-ORD-06) ────────────────────────────────────

/**
 * Atomically claim an idempotency key for (user, key). Runs on the CALLER's
 * transaction client. The UNIQUE(user_id, idempotency_key) makes the INSERT the
 * claim itself — two racing requests cannot both win.
 *  - { claimed: true, claimId }            we own it, proceed to do the work
 *  - { existing: {...} }                   someone already holds it (inspect status)
 *  - { claimed: false }                    a concurrent claim is uncommitted → treat as in-progress
 */
async function claimKey(client, { userId, idempotencyKey, scope, requestHash }) {
  const ins = await client.query(
    `INSERT INTO idempotency_keys (user_id, idempotency_key, request_scope, status, request_hash, expires_at)
     VALUES ($1, $2, $3, 'in_progress', $4, now() + interval '24 hours')
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [userId, idempotencyKey, scope, requestHash]
  );
  if (ins.rows[0]) return { claimed: true, claimId: ins.rows[0].id };

  const ex = await client.query(
    `SELECT id, status, request_hash, response_status, response_body
       FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );
  if (!ex.rows[0]) return { claimed: false };
  return { existing: ex.rows[0] };
}

/** Persist the successful response so later replays return it verbatim. */
async function completeClaim(client, claimId, responseStatus, responseBody) {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'completed', response_status = $2, response_body = $3::jsonb
      WHERE id = $1`,
    [claimId, responseStatus, JSON.stringify(responseBody)]
  );
}

/**
 * Reopen a previously-failed claim so the same key can be retried. This is a
 * compare-and-swap: it only flips a row that is STILL 'failed' and returns
 * whether THIS caller won the re-claim. Without the `status = 'failed'` guard
 * two concurrent retries of a failed key could both reopen it and run the
 * order creation twice — the exact duplicate-order idempotency exists to stop.
 */
async function retakeClaim(client, claimId, requestHash) {
  const r = await client.query(
    `UPDATE idempotency_keys
        SET status = 'in_progress', request_hash = $2, response_status = NULL, response_body = NULL
      WHERE id = $1 AND status = 'failed'
      RETURNING id`,
    [claimId, requestHash]
  );
  return r.rowCount > 0;
}

/** Mark a claim failed (so the key is reusable) after the order rolled back. */
async function failClaim(claimId) {
  await query(`UPDATE idempotency_keys SET status = 'failed' WHERE id = $1`, [claimId]);
}

// ── Inventory locking + availability (the concurrency-safe core) ─────────────

/** Lock a single inventory row FOR UPDATE and return its live stock figures. */
async function lockInventory(client, productId) {
  const r = await client.query(
    `SELECT product_id, physical_quantity, reserved_quantity, available_quantity
       FROM inventory WHERE product_id = $1 FOR UPDATE`,
    [productId]
  );
  return r.rows[0] || null;
}

/** The catalog facts needed to price + validate an order line. */
async function loadProduct(client, productId) {
  const r = await client.query(
    `SELECT id, name, unit_price, tax_rate, is_active FROM products WHERE id = $1`,
    [productId]
  );
  return r.rows[0] || null;
}

/** Reserve stock on create: reserved += qty (available recomputes down). */
async function reserveStock(client, { productId, quantity, orderId, performedBy }) {
  const upd = await client.query(
    `UPDATE inventory
        SET reserved_quantity = reserved_quantity + $2, updated_at = now()
      WHERE product_id = $1
      RETURNING available_quantity`,
    [productId, quantity]
  );
  await client.query(
    `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, order_id, reason)
     VALUES ($1, $2, $3, 'order_reservation', $4, 'Order reservation')`,
    [productId, performedBy, quantity, orderId]
  );
  return upd.rows[0];
}

/** Consume stock on shipment: physical -= qty AND reserved -= qty (available unchanged). */
async function consumeStock(client, { productId, quantity, orderId, performedBy }) {
  const upd = await client.query(
    `UPDATE inventory
        SET physical_quantity = physical_quantity - $2,
            reserved_quantity = reserved_quantity - $2,
            updated_at = now()
      WHERE product_id = $1
      RETURNING physical_quantity, reserved_quantity, available_quantity`,
    [productId, quantity]
  );
  await client.query(
    `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, order_id, reason)
     VALUES ($1, $2, $3, 'fulfillment_consumption', $4, 'Stock consumed on shipment')`,
    [productId, performedBy, -quantity, orderId]
  );
  return upd.rows[0];
}

/** Release a reservation on cancellation: reserved -= qty (available rises). */
async function releaseReservation(client, { productId, quantity, orderId, performedBy }) {
  const upd = await client.query(
    `UPDATE inventory
        SET reserved_quantity = reserved_quantity - $2, updated_at = now()
      WHERE product_id = $1
      RETURNING reserved_quantity, available_quantity`,
    [productId, quantity]
  );
  await client.query(
    `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, order_id, reason)
     VALUES ($1, $2, $3, 'cancellation_release', $4, 'Reservation released on cancellation')`,
    [productId, performedBy, -quantity, orderId]
  );
  return upd.rows[0];
}

// ── Order + item writes ─────────────────────────────────────────────────────

async function insertOrder(client, { customerId, subtotal, taxTotal, grandTotal }) {
  const r = await client.query(
    `INSERT INTO orders (customer_id, status, subtotal, tax_total, grand_total)
     VALUES ($1, 'pending', $2, $3, $4)
     RETURNING id, customer_id, status, subtotal, tax_total, grand_total,
               cancellation_reason, created_at, updated_at`,
    [customerId, subtotal, taxTotal, grandTotal]
  );
  return r.rows[0];
}

async function insertOrderItems(client, orderId, lines) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO order_items
         (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orderId,
        l.product_id,
        l.product_name,
        l.unit_price,
        l.tax_rate,
        l.quantity,
        l.line_total,
        l.line_tax,
      ]
    );
  }
}

async function updateStatus(client, orderId, status, cancellationReason = null) {
  const r = await client.query(
    `UPDATE orders
        SET status = $2,
            cancellation_reason = COALESCE($3, cancellation_reason),
            updated_at = now()
      WHERE id = $1
      RETURNING id, customer_id, status, subtotal, tax_total, grand_total,
                cancellation_reason, created_at, updated_at`,
    [orderId, status, cancellationReason]
  );
  return r.rows[0];
}

/** Empty the caller's cart inside the order transaction (FR-CART-05). */
async function emptyCart(client, customerId) {
  const r = await client.query(
    `DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE customer_id = $1)`,
    [customerId]
  );
  return r.rowCount;
}

// ── Reads ────────────────────────────────────────────────────────────────────

const ORDER_SELECT = `
  o.id, o.customer_id, o.status, o.subtotal, o.tax_total, o.grand_total,
  o.cancellation_reason, o.created_at, o.updated_at`;

const ITEM_SELECT = `
  oi.id, oi.product_id, oi.product_name, oi.unit_price, oi.tax_rate,
  oi.quantity, oi.line_total, oi.line_tax`;

function mapOrder(row) {
  return {
    id: String(row.id),
    customer_id: String(row.customer_id),
    status: row.status,
    subtotal: row.subtotal, // NUMERIC → string
    tax_total: row.tax_total,
    grand_total: row.grand_total,
    cancellation_reason: row.cancellation_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapItem(row) {
  return {
    id: String(row.id),
    product_id: String(row.product_id),
    product_name: row.product_name,
    unit_price: row.unit_price,
    tax_rate: row.tax_rate,
    quantity: row.quantity,
    line_total: row.line_total,
    line_tax: row.line_tax,
  };
}

/** Load one order row (by id) optionally restricted to an owner (customer). */
async function findOrder(orderId, { customerId = null } = {}, client = null) {
  const r = await executor(client).query(
    `SELECT ${ORDER_SELECT} FROM orders o
      WHERE o.id = $1${customerId !== null ? ' AND o.customer_id = $2' : ''}`,
    customerId !== null ? [orderId, customerId] : [orderId]
  );
  return r.rows[0] ? mapOrder(r.rows[0]) : null;
}

/**
 * Like findOrder, but takes a `SELECT … FOR UPDATE` row lock so concurrent
 * status transitions / cancellations of the SAME order serialize (Phase 11
 * hardening): without it, two simultaneous ships (or ship+cancel) could both
 * read 'confirmed' and double-consume/double-release stock when other
 * reservations on the product mask the invariant checks. Callers MUST take
 * this lock BEFORE any inventory row locks — createOrder never locks an
 * existing orders row, so the global order locks→inventory cannot deadlock.
 */
async function lockOrder(client, orderId, { customerId = null } = {}) {
  const r = await client.query(
    `SELECT ${ORDER_SELECT} FROM orders o
      WHERE o.id = $1${customerId !== null ? ' AND o.customer_id = $2' : ''}
      FOR UPDATE`,
    customerId !== null ? [orderId, customerId] : [orderId]
  );
  return r.rows[0] ? mapOrder(r.rows[0]) : null;
}

async function findItems(orderId, client = null) {
  const r = await executor(client).query(
    `SELECT ${ITEM_SELECT} FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.id ASC`,
    [orderId]
  );
  return r.rows.map(mapItem);
}

/** Live stock rows for an order (for staff detail views / warnings) by product ids. */
async function availabilityFor(orderId, client = null) {
  const r = await executor(client).query(
    `SELECT oi.product_id, COALESCE(i.available_quantity, 0) AS available_quantity
       FROM order_items oi LEFT JOIN inventory i ON i.product_id = oi.product_id
      WHERE oi.order_id = $1`,
    [orderId]
  );
  return r.rows;
}

/**
 * Paginated order list. `customerId` restricts to one owner (customers); staff
 * pass null to see all, optionally filtered by status. Newest first.
 */
async function listOrders({ customerId = null, status = null, page, limit }) {
  const clauses = [];
  const args = [];
  if (customerId !== null) {
    args.push(customerId);
    clauses.push(`o.customer_id = $${args.length}`);
  }
  if (status) {
    args.push(status);
    clauses.push(`o.status = $${args.length}`);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countRes = await query(`SELECT count(*)::int AS total FROM orders o ${whereSql}`, args);
  const total = countRes.rows[0].total;

  const dataArgs = args.concat([limit, (page - 1) * limit]);
  const dataRes = await query(
    `SELECT ${ORDER_SELECT} FROM orders o ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    dataArgs
  );
  return { rows: dataRes.rows.map(mapOrder), total };
}

module.exports = {
  claimKey,
  completeClaim,
  retakeClaim,
  failClaim,
  lockInventory,
  loadProduct,
  reserveStock,
  consumeStock,
  releaseReservation,
  insertOrder,
  insertOrderItems,
  updateStatus,
  emptyCart,
  findOrder,
  lockOrder,
  findItems,
  availabilityFor,
  listOrders,
  mapOrder,
  mapItem,
};
