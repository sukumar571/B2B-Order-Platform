'use strict';

/**
 * Data access for `products` (+ joined inventory) — parameterized SQL only
 * (C-04). Sort direction/column and active-filter are taken from server-side
 * whitelists, never interpolated from raw user input. Money columns come back
 * from `pg` as strings already (NUMERIC), matching the API's money-as-string
 * convention.
 */

const { query } = require('../db/pool');

// When called mid-transaction, reads must go through the SAME client so they
// observe the uncommitted write; otherwise fall back to the shared pool.
const poolExecutor = { query: (sql, args) => query(sql, args) };
function executor(client) {
  return client || poolExecutor;
}

// Whitelist: public sort key -> a fixed SQL fragment. User input only ever
// selects a key, so there is no injection surface in ORDER BY.
const SORT_SQL = {
  name: 'p.name',
  price: 'p.unit_price',
  sku: 'p.sku',
  created_at: 'p.created_at',
  available: 'available_stock',
};

const SELECT_COLS = `
  p.id, p.sku, p.name, p.description, p.unit_price, p.tax_rate, p.is_active,
  p.created_at, p.updated_at,
  COALESCE(i.physical_quantity, 0)  AS physical_quantity,
  COALESCE(i.reserved_quantity, 0)  AS reserved_quantity,
  COALESCE(i.available_quantity, 0) AS available_stock,
  COALESCE(i.low_stock_threshold, 0) AS low_stock_threshold`;

/** Map a joined DB row to the public product shape (id as string). */
function mapProduct(row) {
  return {
    id: String(row.id),
    sku: row.sku,
    name: row.name,
    description: row.description,
    unit_price: row.unit_price, // NUMERIC → string
    tax_rate: row.tax_rate,
    is_active: row.is_active,
    physical_quantity: row.physical_quantity,
    reserved_quantity: row.reserved_quantity,
    available_stock: row.available_stock,
    low_stock_threshold: row.low_stock_threshold,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Build the shared WHERE clause + args for list + count (never interpolates). */
function buildFilter({ search, activeOnly }) {
  const clauses = [];
  const args = [];
  if (activeOnly === true) clauses.push('p.is_active = true');
  if (search) {
    args.push(`%${search}%`);
    const n = args.length;
    clauses.push(`(p.name ILIKE $${n} OR p.sku ILIKE $${n} OR p.description ILIKE $${n})`);
  }
  return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/**
 * Paginated catalog listing. Returns { rows, total }.
 * `sortKey`/`order` are validated upstream; still re-checked against the
 * whitelist here as defence-in-depth.
 */
async function listProducts({ search, activeOnly, sortKey = 'name', order = 'asc', page, limit }) {
  const { whereSql, args } = buildFilter({ search, activeOnly });
  const col = SORT_SQL[sortKey] || SORT_SQL.name;
  const dir = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const countRes = await query(
    `SELECT count(*)::int AS total
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       ${whereSql}`,
    args
  );
  const total = countRes.rows[0].total;

  const dataArgs = args.concat([limit, (page - 1) * limit]);
  const dataRes = await query(
    `SELECT ${SELECT_COLS}
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       ${whereSql}
       ORDER BY ${col} ${dir}, p.id ASC
       LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    dataArgs
  );
  return { rows: dataRes.rows.map(mapProduct), total };
}

/** Full product (with inventory) by id, or null. Service decides visibility. */
async function findById(id, client = null) {
  const r = await executor(client).query(
    `SELECT ${SELECT_COLS}
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.id = $1`,
    [id]
  );
  return r.rows[0] ? mapProduct(r.rows[0]) : null;
}

/** Used to detect SKU collisions (case-sensitive, matching the DB UNIQUE). */
async function findBySku(sku) {
  const r = await query(
    `SELECT ${SELECT_COLS} FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id WHERE p.sku = $1`,
    [sku]
  );
  return r.rows[0] ? mapProduct(r.rows[0]) : null;
}

/**
 * Insert a product row inside a transaction client. A duplicate SKU surfaces
 * as PostgreSQL error 23505 (products_sku_uq) — the service maps it to 409.
 */
async function insert(client, { sku, name, description, unitPrice, taxRate, isActive }) {
  const r = await client.query(
    `INSERT INTO products (sku, name, description, unit_price, tax_rate, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [sku, name, description, unitPrice, taxRate, isActive]
  );
  return r.rows[0].id;
}

/**
 * PATCH a product (partial). `patch` keys are already whitelisted by the
 * service; column names are a fixed map — values are always parameterized.
 */
const UPDATE_COLUMN_MAP = {
  sku: 'sku',
  name: 'name',
  description: 'description',
  unit_price: 'unit_price',
  tax_rate: 'tax_rate',
  is_active: 'is_active',
};

async function update(client, id, patch) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(UPDATE_COLUMN_MAP)) {
    if (patch[key] !== undefined) {
      args.push(patch[key]);
      sets.push(`${column} = $${args.length}`);
    }
  }
  if (sets.length === 0) return findById(id, client);
  sets.push('updated_at = now()');
  args.push(id);
  await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
  return findById(id, client);
}

module.exports = {
  listProducts,
  findById,
  findBySku,
  insert,
  update,
  mapProduct,
};
