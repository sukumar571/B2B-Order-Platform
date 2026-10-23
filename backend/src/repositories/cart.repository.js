'use strict';

/**
 * Data access for `carts` + `cart_items` — parameterized SQL only (C-04).
 *
 * Every read/write is scoped by the AUTHENTICATED customer id (from the token)
 * or by a cart_id already proven to belong to that customer. There is no path
 * that accepts a cart id or customer id from the request body, which is what
 * makes cross-user cart access structurally impossible (NFR-04 / AC-CART-05).
 *
 * Prices/stock are NEVER stored on the cart line — they are JOINed live from
 * products/inventory on every read, so a cart always reflects the current
 * catalog until checkout (and a product that went inactive is surfaced so the
 * service can flag it).
 */

const { query } = require('../db/pool');

function executor(client) {
  return client || { query: (sql, args) => query(sql, args) };
}

/**
 * Return the caller's cart id, creating the single per-customer cart on first
 * use. carts.customer_id is UNIQUE, so ON CONFLICT resolves the race by
 * returning the existing row instead of erroring.
 */
async function ensureCart(client, customerId) {
  const r = await client.query(
    `INSERT INTO carts (customer_id, updated_at)
     VALUES ($1, now())
     ON CONFLICT (customer_id) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [customerId]
  );
  return r.rows[0].id;
}

const LINE_SELECT = `
  ci.id            AS item_id,
  p.id             AS product_id,
  p.name           AS product_name,
  p.sku            AS sku,
  p.unit_price     AS unit_price,
  p.tax_rate       AS tax_rate,
  p.is_active      AS product_is_active,
  ci.quantity      AS quantity,
  COALESCE(i.available_quantity, 0) AS available_now`;

/** Map a joined row to the safe cart-line shape (ids as strings, money as strings). */
function mapLine(row) {
  return {
    id: String(row.item_id),
    product_id: String(row.product_id),
    product_name: row.product_name,
    sku: row.sku,
    unit_price: row.unit_price, // NUMERIC → string
    tax_rate: row.tax_rate, // NUMERIC → string
    product_is_active: row.product_is_active,
    quantity: row.quantity,
    available_now: row.available_now,
  };
}

/**
 * The caller's cart header (id + timestamps), or null when none exists yet.
 * Scoped strictly by customer_id.
 */
async function findCart(customerId, client = null) {
  const r = await executor(client).query(
    `SELECT id, created_at, updated_at FROM carts WHERE customer_id = $1`,
    [customerId]
  );
  return r.rows[0] || null;
}

/**
 * All cart lines for the caller, prices/stock live via JOIN. Ordered stably by
 * insertion so the UI is deterministic.
 */
async function findLines(customerId, client = null) {
  const r = await executor(client).query(
    `SELECT ${LINE_SELECT}
       FROM cart_items ci
       JOIN carts c        ON c.id = ci.cart_id AND c.customer_id = $1
       JOIN products p     ON p.id = ci.product_id
       LEFT JOIN inventory i ON i.product_id = p.id
      ORDER BY ci.created_at ASC, ci.id ASC`,
    [customerId]
  );
  return r.rows.map(mapLine);
}

/** Current quantity of a product in this cart (0 when not present yet). */
async function getLineQuantity(client, cartId, productId) {
  const r = await client.query(
    `SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
    [cartId, productId]
  );
  return r.rows[0] ? r.rows[0].quantity : null;
}

/** Minimal product facts needed to gate an add/update (active + sellable qty). */
async function loadProduct(client, productId) {
  const r = await executor(client).query(
    `SELECT p.id, p.is_active, COALESCE(i.available_quantity, 0) AS available_stock
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.id = $1`,
    [productId]
  );
  if (!r.rows[0]) return null;
  return {
    id: r.rows[0].id,
    is_active: r.rows[0].is_active,
    available_stock: r.rows[0].available_stock,
  };
}

/** A single cart line owned by THIS cart, or null (→ 404, never 403). */
async function findItem(client, cartId, itemId) {
  const r = await executor(client).query(
    `SELECT id, product_id, quantity FROM cart_items WHERE id = $1 AND cart_id = $2`,
    [itemId, cartId]
  );
  return r.rows[0] || null;
}

/**
 * Upsert semantics (FR-CART-01 / AC-CART-01): adding a product already in the
 * cart increases its quantity rather than duplicating the line. The DB UNIQUE
 * (cart_id, product_id) is the source of truth for that merge.
 */
async function upsertItem(client, cartId, productId, addQuantity) {
  const r = await client.query(
    `INSERT INTO cart_items (cart_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, product_id)
     DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = now()
     RETURNING id, quantity`,
    [cartId, productId, addQuantity]
  );
  return r.rows[0];
}

/** Set an absolute quantity on a line already proven to belong to the cart. */
async function setItemQuantity(client, cartId, itemId, quantity) {
  const r = await client.query(
    `UPDATE cart_items SET quantity = $3, updated_at = now()
      WHERE id = $1 AND cart_id = $2
      RETURNING id, quantity`,
    [itemId, cartId, quantity]
  );
  return r.rows[0] || null;
}

/** Remove one line from this cart. Returns true when a row was deleted. */
async function deleteItem(client, cartId, itemId) {
  const r = await client.query(`DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`, [
    itemId,
    cartId,
  ]);
  return r.rowCount > 0;
}

/** Empty every line of this cart (FR-CART-05). */
async function clearItems(client, cartId) {
  const r = await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
  return r.rowCount;
}

module.exports = {
  ensureCart,
  findCart,
  findLines,
  getLineQuantity,
  loadProduct,
  findItem,
  upsertItem,
  setItemQuantity,
  deleteItem,
  clearItems,
};
