'use strict';

/**
 * Data access for `inventory` + `inventory_movements` — parameterized SQL only
 * (C-04). Stock changes ALWAYS run on a transaction client and lock the row
 * (SELECT … FOR UPDATE) so concurrent adjustments serialize and the DB CHECKs
 * (available >= 0, physical >= 0) remain the final overselling guard.
 *
 * LOW-STOCK rule (see migration 14): a product is low-stock when
 * available_quantity <= low_stock_threshold.
 */

const { query } = require('../db/pool');

const INV_SELECT = `
  i.product_id, p.sku, p.name, p.is_active,
  i.physical_quantity, i.reserved_quantity, i.available_quantity,
  i.low_stock_threshold,
  (i.available_quantity <= i.low_stock_threshold) AS is_low_stock`;

function mapInventory(row) {
  return {
    product_id: String(row.product_id),
    sku: row.sku,
    name: row.name,
    is_active: row.is_active,
    physical_quantity: row.physical_quantity,
    reserved_quantity: row.reserved_quantity,
    available_quantity: row.available_quantity,
    low_stock_threshold: row.low_stock_threshold,
    is_low_stock: row.is_low_stock,
  };
}

/** Create the 1:1 inventory row for a freshly inserted product. */
async function insertRow(client, { productId, physical, lowStockThreshold }) {
  const r = await client.query(
    `INSERT INTO inventory (product_id, physical_quantity, reserved_quantity, low_stock_threshold)
     VALUES ($1, $2, 0, $3)
     RETURNING product_id`,
    [productId, physical, lowStockThreshold]
  );
  return r.rows[0].product_id;
}

/** Current inventory row for a product, optionally locked FOR UPDATE. */
async function findByProductId(client, productId, { forUpdate = false } = {}) {
  const r = await client.query(
    `SELECT product_id, physical_quantity, reserved_quantity, available_quantity, low_stock_threshold
       FROM inventory WHERE product_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productId]
  );
  return r.rows[0] || null;
}

/** Inventory + product identity (public shape) for a response, by product id. */
async function findByIdJoined(productId, client = null) {
  const ex = client || { query: (sql, args) => query(sql, args) };
  const r = await ex.query(
    `SELECT ${INV_SELECT}
       FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.product_id = $1`,
    [productId]
  );
  return r.rows[0] ? mapInventory(r.rows[0]) : null;
}

/** Apply a signed change to physical on-hand stock (available recomputes). */
async function adjustPhysical(client, productId, delta) {
  const r = await client.query(
    `UPDATE inventory
        SET physical_quantity = physical_quantity + $2, updated_at = now()
      WHERE product_id = $1
      RETURNING product_id, physical_quantity, reserved_quantity, available_quantity`,
    [productId, delta]
  );
  return r.rows[0];
}

/** Set the per-product low-stock threshold. */
async function setThreshold(client, productId, threshold) {
  const r = await client.query(
    `UPDATE inventory SET low_stock_threshold = $2, updated_at = now()
      WHERE product_id = $1
      RETURNING product_id, low_stock_threshold`,
    [productId, threshold]
  );
  return r.rows[0];
}

/** Append-only movement ledger entry (FR-CAT-06). */
async function insertMovement(
  client,
  { productId, performedBy, quantityDelta, movementType, reason }
) {
  const r = await client.query(
    `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [productId, performedBy, quantityDelta, movementType, reason]
  );
  return r.rows[0];
}

function buildListWhere({ search, activeOnly, lowStockOnly }) {
  const clauses = [];
  const args = [];
  if (activeOnly) clauses.push('p.is_active = true');
  if (lowStockOnly) clauses.push('i.available_quantity <= i.low_stock_threshold');
  if (search) {
    args.push(`%${search}%`);
    const n = args.length;
    clauses.push(`(p.name ILIKE $${n} OR p.sku ILIKE $${n})`);
  }
  return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/** Staff inventory table: join products + inventory, paginated. */
async function listInventory({ search, activeOnly, lowStockOnly, page, limit }) {
  const { whereSql, args } = buildListWhere({ search, activeOnly, lowStockOnly });

  const countRes = await query(
    `SELECT count(*)::int AS total
       FROM inventory i JOIN products p ON p.id = i.product_id
       ${whereSql}`,
    args
  );
  const total = countRes.rows[0].total;

  const dataArgs = args.concat([limit, (page - 1) * limit]);
  const dataRes = await query(
    `SELECT ${INV_SELECT}
       FROM inventory i JOIN products p ON p.id = i.product_id
       ${whereSql}
       ORDER BY (i.available_quantity <= i.low_stock_threshold) DESC, p.name ASC
       LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    dataArgs
  );
  return { rows: dataRes.rows.map(mapInventory), total };
}

module.exports = {
  mapInventory,
  insertRow,
  findByProductId,
  findByIdJoined,
  adjustPhysical,
  setThreshold,
  insertMovement,
  listInventory,
};
