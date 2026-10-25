'use strict';

/**
 * Performance scale seed — builds the isolated benchmark dataset for NFR-PERF-01.
 *
 *   npm run perf:seed            # 500 products, 200 customers, 1,000 orders (defaults)
 *   SCALE_PRODUCTS=800 npm run perf:seed
 *
 * It runs entirely against the dedicated benchmark database resolved by
 * perf-config.js (default `b2b_oms_perf`) — NEVER the development `b2b_oms` or
 * the shared `b2b_oms_test`. Steps:
 *   1. CREATE DATABASE the perf db if it does not exist (connects to `postgres`).
 *   2. Apply pending migrations (idempotent, node-pg-migrate — never drops).
 *   3. Batch-insert scale users / products / inventory / orders, all-or-nothing.
 *
 * Non-destructive & idempotent: if the target product/order counts already exist
 * the seed is skipped. Re-run with `PERF_RESET=1` to TRUNCATE the benchmark db
 * (only ever the benchmark db) and rebuild from scratch.
 *
 * Passwords are bcrypt hashes only (FR-AUTH-03); a single dev-only password is
 * shared across benchmark accounts (never a real credential, never reused in prod).
 */

const { Client, Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const pm = require('node-pg-migrate');
const migrate = pm.default || pm;
const { resolvePerfDatabaseUrl } = require('./perf-config');

const DEV_PASSWORD = process.env.PERF_DEV_PASSWORD || 'Passw0rd!';
const PRODUCTS = intEnv('SCALE_PRODUCTS', 500);
const CUSTOMERS = intEnv('SCALE_CUSTOMERS', 200);
const ORDERS = intEnv('SCALE_ORDERS', 1000);
const PHYSICAL_STOCK = intEnv('SCALE_STOCK', 1000000); // headroom so load never starves stock
const RESET = process.env.PERF_RESET === '1';

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: "${raw}"`);
  return n;
}

// Deterministic PRNG (mulberry32) so two benchmark runs generate identical data.
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { perfUrl, perfName } = resolvePerfDatabaseUrl();

/** Connect to the maintenance db on the same server and CREATE DATABASE if missing. */
async function ensureDatabaseExists() {
  const maintenanceUrl = perfUrl.replace(/\/[^/]+$/, '/postgres');
  const client = new Client({ connectionString: maintenanceUrl });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [perfName]);
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE "${perfName}"`); // name validated in perf-config
      console.log(`Created benchmark database "${perfName}".`);
    } else {
      console.log(`Benchmark database "${perfName}" already exists.`);
    }
  } finally {
    await client.end();
  }
}

async function runMigrations() {
  await migrate({
    direction: 'up',
    databaseUrl: perfUrl,
    dir: path.join(__dirname, '..', '..', 'migrations'),
    migrationsTable: 'pgmigrations',
    schema: 'public',
    verbose: false,
    log: () => {},
  });
  console.log('Applied migrations to the benchmark database.');
}

async function currentCounts(client) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM products)  AS products,
            (SELECT count(*) FROM users)     AS users,
            (SELECT count(*) FROM orders)    AS orders`
  );
  return {
    products: Number(rows[0].products),
    users: Number(rows[0].users),
    orders: Number(rows[0].orders),
  };
}

async function seedUsers(client, hash) {
  // 1 admin + CUSTOMERS customers. Chunked multi-row VALUES for speed.
  const rows = [['perf-admin@perf.test', 'Perf Admin', 'admin']];
  for (let i = 1; i <= CUSTOMERS; i++) {
    rows.push([`perf-customer-${i}@perf.test`, `Perf Customer ${i}`, 'customer']);
  }
  await insertInChunks(
    client,
    'users',
    ['email', 'password_hash', 'name', 'role', 'is_active'],
    rows,
    (r) => [r[0], hash, r[1], r[2], true]
  );
}

async function seedProducts(client) {
  const rng = makeRng(1234);
  // Build all products first (single chunked insert), then their inventory.
  const productRows = [];
  for (let i = 1; i <= PRODUCTS; i++) {
    const price = (1 + Math.floor(rng() * 9900) / 100).toFixed(2); // 1.00 .. 100.00
    const tax = ['0.00', '7.50', '18.00'][Math.floor(rng() * 3)];
    productRows.push([
      `PERF-SKU-${String(i).padStart(5, '0')}`,
      `Perf Product ${i}`,
      'Benchmark catalog item',
      price,
      tax,
      true,
    ]);
  }
  await insertInChunks(
    client,
    'products',
    ['sku', 'name', 'description', 'unit_price', 'tax_rate', 'is_active'],
    productRows
  );
}

async function seedInventory(client) {
  // One inventory row per benchmark product, high physical stock, reserved 0.
  await client.query(
    `INSERT INTO inventory (product_id, physical_quantity, reserved_quantity)
     SELECT id, $1, 0 FROM products
     WHERE sku LIKE 'PERF-SKU-%'
       AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = products.id)`,
    [PHYSICAL_STOCK]
  );
}

async function seedOrders(client) {
  const rng = makeRng(987654321);
  const { rows: custRows } = await client.query(
    `SELECT id FROM users WHERE role = 'customer' ORDER BY id`
  );
  const { rows: prodRows } = await client.query(
    `SELECT id FROM products WHERE sku LIKE 'PERF-SKU-%' ORDER BY id`
  );
  if (custRows.length === 0 || prodRows.length === 0) {
    throw new Error('seedOrders requires seeded customers and products');
  }
  const customers = custRows.map((r) => r.id);
  const products = prodRows.map((r) => r.id);
  // Lifecycle statuses per migration 16 (pending/confirmed/processing/shipped/delivered).
  // 'cancelled' is omitted because it requires a cancellation_reason (DB CHECK).
  const STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];

  for (let n = 0; n < ORDERS; n++) {
    const customerId = customers[Math.floor(rng() * customers.length)];
    const status = STATUSES[Math.floor(rng() * STATUSES.length)];
    const orderRes = await client.query(
      `INSERT INTO orders (customer_id, status, subtotal, tax_total, grand_total)
       VALUES ($1, $2, 0, 0, 0) RETURNING id`,
      [customerId, status]
    );
    const orderId = orderRes.rows[0].id;

    // 1-3 distinct products per order (order_items has UNIQUE(order_id, product_id)).
    const lineCount = 1 + Math.floor(rng() * 3);
    const chosen = new Set();
    while (chosen.size < lineCount) chosen.add(products[Math.floor(rng() * products.length)]);

    for (const productId of chosen) {
      const qty = 1 + Math.floor(rng() * 5);
      // Copy the catalog snapshot (name/price/tax) and let PostgreSQL compute the
      // exact NUMERIC line totals, guaranteeing the DB CHECK invariants hold.
      await client.query(
        `INSERT INTO order_items
           (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
         SELECT $1, p.id, p.name, p.unit_price, p.tax_rate, $2::int,
                p.unit_price * $2,
                ROUND(p.unit_price * $2 * p.tax_rate / 100, 2)
         FROM products p WHERE p.id = $3`,
        [orderId, qty, productId]
      );
    }

    // Roll the snapshot line amounts up into the order totals (grand = subtotal + tax, exact).
    await client.query(
      `UPDATE orders o
         SET subtotal = agg.subtotal,
             tax_total = agg.tax_total,
             grand_total = agg.subtotal + agg.tax_total
        FROM (
          SELECT COALESCE(SUM(line_total), 0)::numeric(12,2) AS subtotal,
                 COALESCE(SUM(line_tax), 0)::numeric(12,2)  AS tax_total
            FROM order_items WHERE order_id = $1
        ) agg
       WHERE o.id = $1`,
      [orderId]
    );
  }
}

/** Insert many rows via chunked parameterized multi-row VALUES (never string interpolation). */
async function insertInChunks(client, table, columns, rows, map = (r) => r) {
  const CHUNK = 500;
  const colList = columns.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params = [];
    const valueTuples = slice.map((row, ri) => {
      const vals = map(row);
      const placeholders = vals.map((_v, ci) => {
        params.push(vals[ci]);
        return `$${ri * vals.length + ci + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${colList}) VALUES ${valueTuples.join(', ')}`,
      params
    );
  }
}

(async () => {
  const startedAt = Date.now();
  console.log(`Target benchmark database: ${perfName} (isolated; dev/test DBs are never touched)`);
  await ensureDatabaseExists();
  await runMigrations();

  const pool = new Pool({ connectionString: perfUrl, max: 4 });
  const client = await pool.connect();
  try {
    const counts = await currentCounts(client);
    const alreadySeeded =
      counts.products >= PRODUCTS && counts.users >= CUSTOMERS + 1 && counts.orders >= ORDERS;
    if (alreadySeeded && !RESET) {
      console.log(
        `Benchmark data already present (${counts.products} products, ` +
          `${counts.users} users, ${counts.orders} orders) — nothing changed.`
      );
      return;
    }
    if (RESET) {
      console.log('PERF_RESET=1 — truncating the BENCHMARK database only (never dev/test)…');
      await client.query(`TRUNCATE TABLE orders, order_items, products, inventory, users CASCADE`);
    }

    const hash = await bcrypt.hash(DEV_PASSWORD, 12);
    await client.query('BEGIN');
    await seedUsers(client, hash);
    await seedProducts(client);
    await seedInventory(client);
    await seedOrders(client);
    await client.query('COMMIT');

    const after = await currentCounts(client);
    console.log(
      `Seeded benchmark in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
        `${after.products} products, ${after.users} users, ${after.orders} orders ` +
        `(dev-only password: "${DEV_PASSWORD}").`
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Benchmark seed failed, rolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
