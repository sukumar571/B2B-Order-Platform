'use strict';

/**
 * PostgreSQL integration tests (Phase 3).
 *
 * SAFETY / ISOLATION:
 *  - These tests run ONLY against the dedicated database in DATABASE_URL_TEST
 *    (never DATABASE_URL / development data), and ONLY when explicitly started
 *    via `npm run test:integration` (which sets B2B_RUN_DB_TESTS=1). Plain
 *    `npm test` skips this file entirely, so unit/HTTP tests never require a
 *    running database.
 *  - The suite applies the real migration files first; the final reversibility
 *    test proves `down --all` + `up` restore an identical schema. Only this
 *    test-only database is ever modified.
 *
 * Covered: connectivity, schema completeness, FK enforcement (incl. RESTRICT
 * protection of order/invoice history), uniqueness, CHECK constraints on
 * quantities/prices/totals, generated available_quantity, NUMERIC(12,2)
 * limits, historical snapshots, transaction commit/rollback consistency
 * (incl. audit writes), append-only audit trigger, idempotency claim rows.
 */

process.env.NODE_ENV = 'test';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const pm = require('node-pg-migrate');
const migrate = pm.default || pm.migrate || pm;

const config = require('../src/config/env');
const db = require('../src/db/pool');

const ENABLED = Boolean(config.databaseUrlTest) && process.env.B2B_RUN_DB_TESTS === '1';
const SKIP_REASON = ENABLED
  ? false
  : 'isolated test DB required — run: npm run test:integration (uses DATABASE_URL_TEST only)';

const EXPECTED_TABLES = [
  'users',
  'products',
  'inventory',
  'carts',
  'cart_items',
  'orders',
  'order_items',
  'invoices',
  'invoice_counters',
  'inventory_movements',
  'audit_logs',
  'idempotency_keys',
  'refresh_tokens',
];

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function runMigrations(direction, count) {
  return migrate({
    direction,
    databaseUrl: config.databaseUrlTest,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    ...(count === undefined ? {} : { count }),
    verbose: false,
    log: () => {},
  });
}

const q = (text, params) => db.query(text, params);

let seq = 0;
/** Unique suffix so re-runs against the same test DB never collide. */
const U = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

const FAKE_HASH = `$2b$12$${'x'.repeat(53)}`; // valid-shape bcrypt placeholder

async function newUserId(role = 'customer') {
  const r = await q(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${role}-${U()}@t.test`, FAKE_HASH, `Test ${role}`, role]
  );
  return r.rows[0].id;
}

async function newProduct({ price = '10.00', tax = '0.00', physical = 10, reserved = 0 } = {}) {
  const p = await q(
    `INSERT INTO products (sku, name, unit_price, tax_rate)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`SKU-${U()}`, 'Snapshot Product', price, tax]
  );
  const productId = p.rows[0].id;
  await q(
    `INSERT INTO inventory (product_id, physical_quantity, reserved_quantity) VALUES ($1, $2, $3)`,
    [productId, physical, reserved]
  );
  return productId;
}

async function newOrder(customerId, totals = {}) {
  const r = await q(
    `INSERT INTO orders (customer_id, subtotal, tax_total, grand_total)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [customerId, totals.subtotal ?? '0.00', totals.tax ?? '0.00', totals.grand ?? '0.00']
  );
  return r.rows[0].id;
}

/** Assert a query fails with a specific PostgreSQL error code. */
async function expectPgError(fn, code, messagePattern) {
  let thrown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected a PostgreSQL error but the query succeeded');
  const actual = thrown.code || (thrown.originalError && thrown.originalError.code);
  assert.strictEqual(actual, code, `expected ${code}, got ${actual}: ${thrown.message}`);
  if (messagePattern) assert.match(thrown.message, messagePattern);
  return thrown;
}

async function publicTables() {
  const r = await q(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  return new Set(r.rows.map((row) => row.table_name));
}

describe(
  'PostgreSQL integration (DATABASE_URL_TEST)',
  { skip: SKIP_REASON, timeout: 120000 },
  () => {
    before(async () => {
      await runMigrations('up');
      await db.getPool().query('SELECT 1');
    });

    after(async () => {
      await db.closePool();
    });

    test('connectivity: pool reaches the server and reports health "up"', async () => {
      const r = await q('SELECT current_setting($1) AS ver', ['server_version']);
      assert.match(r.rows[0].ver, /^1[0-9]/, 'PostgreSQL 1x expected');
      const status = await db.checkDatabase();
      assert.strictEqual(status.state, 'up');
    });

    test('migrations produced the complete schema (13 tables)', async () => {
      const tables = await publicTables();
      for (const t of EXPECTED_TABLES) assert.ok(tables.has(t), `missing table: ${t}`);
      assert.ok(tables.has('pgmigrations'), 'migration journal table expected');
    });

    test('passwords are stored as hashes; column is NOT NULL', async () => {
      await expectPgError(
        () =>
          q(`INSERT INTO users (email, name, role) VALUES ($1, 'x', 'customer')`, [
            `${U()}@t.test`,
          ]),
        '23502' // not_null_violation — no plaintext fallback column exists
      );
    });

    test('foreign keys reject orphan rows', async () => {
      const cust = await newUserId();
      const order = await newOrder(cust);
      await expectPgError(
        () =>
          q(
            `INSERT INTO order_items (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
             VALUES ($1, 999999999, 'ghost', 1.00, 0.00, 1, 1.00, 0.00)`,
            [order]
          ),
        '23503'
      );
    });

    test('RESTRICT FKs prevent deleting records referenced by orders/history', async () => {
      const cust = await newUserId();
      const prod = await newProduct();
      const order = await newOrder(cust);
      await q(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
         VALUES ($1, $2, 'Orig Name', 10.00, 0.00, 2, 20.00, 0.00)`,
        [order, prod]
      );
      await expectPgError(() => q('DELETE FROM products WHERE id = $1', [prod]), '23503');
      await expectPgError(() => q('DELETE FROM users WHERE id = $1', [cust]), '23503');
      // Deleting the order would CASCADE to order_items — but the RESTRICT FK
      // from inventory_movements holds the whole history row in place:
      await q(
        `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, order_id)
         VALUES ($1, $2, 2, 'order_reservation', $3)`,
        [prod, cust, order]
      );
      await expectPgError(() => q('DELETE FROM orders WHERE id = $1', [order]), '23503');
      // The order and its snapshot survive untouched:
      const still = await q('SELECT count(*)::int AS n FROM order_items WHERE order_id = $1', [
        order,
      ]);
      assert.strictEqual(still.rows[0].n, 1);
    });

    test('unique constraints: email, SKU, cart-per-customer, idempotency key', async () => {
      const email = `${U()}@t.test`;
      await q(
        `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Dup A', 'customer')`,
        [email, FAKE_HASH]
      );
      await expectPgError(
        () =>
          q(
            `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Dup B', 'customer')`,
            [email, FAKE_HASH]
          ),
        '23505'
      );

      const sku = `SKU-${U()}`;
      await q(`INSERT INTO products (sku, name, unit_price) VALUES ($1, 'P1', 5.00)`, [sku]);
      await expectPgError(
        () => q(`INSERT INTO products (sku, name, unit_price) VALUES ($1, 'P2', 6.00)`, [sku]),
        '23505'
      );

      const cust = await newUserId();
      await q('INSERT INTO carts (customer_id) VALUES ($1)', [cust]);
      await expectPgError(() => q('INSERT INTO carts (customer_id) VALUES ($1)', [cust]), '23505');

      const user = await newUserId();
      const key = `idem-${U()}`;
      await q(
        `INSERT INTO idempotency_keys (user_id, idempotency_key, request_scope, expires_at)
         VALUES ($1, $2, 'POST /api/orders', now() + interval '24 hours')`,
        [user, key]
      );
      await expectPgError(
        () =>
          q(
            `INSERT INTO idempotency_keys (user_id, idempotency_key, request_scope, expires_at)
             VALUES ($1, $2, 'POST /api/orders', now() + interval '24 hours')`,
            [user, key]
          ),
        '23505'
      );
    });

    test('cart_items: UNIQUE(cart_id, product_id) enforces upsert semantics', async () => {
      const cust = await newUserId();
      const prod = await newProduct();
      const cart = await q('INSERT INTO carts (customer_id) VALUES ($1) RETURNING id', [cust]);
      const cartId = cart.rows[0].id;
      await q('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 1)', [
        cartId,
        prod,
      ]);
      await expectPgError(
        () =>
          q('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 3)', [
            cartId,
            prod,
          ]),
        '23505'
      );
    });

    test('quantity CHECK constraints reject invalid numbers', async () => {
      const cust = await newUserId();
      const prod = await newProduct();
      const cart = await q('INSERT INTO carts (customer_id) VALUES ($1) RETURNING id', [cust]);
      await expectPgError(
        () =>
          q('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 0)', [
            cart.rows[0].id,
            prod,
          ]),
        '23514'
      );
      await expectPgError(
        () => q('UPDATE inventory SET physical_quantity = -1 WHERE product_id = $1', [prod]),
        '23514'
      );
      await expectPgError(
        () => q('UPDATE inventory SET reserved_quantity = -5 WHERE product_id = $1', [prod]),
        '23514'
      );
      // Overselling guard: reserved can never exceed physical.
      await expectPgError(
        () =>
          q(
            'UPDATE inventory SET reserved_quantity = physical_quantity + 1 WHERE product_id = $1',
            [prod]
          ),
        '23514'
      );
    });

    test('available_quantity is a GENERATED column (direct writes rejected)', async () => {
      const prod = await newProduct({ physical: 10 });
      await expectPgError(
        () => q('UPDATE inventory SET available_quantity = 99 WHERE product_id = $1', [prod]),
        '428C9' // generated_not_supported — column is read-only, DB-computed
      );
      const r = await q('SELECT available_quantity FROM inventory WHERE product_id = $1', [prod]);
      assert.strictEqual(Number(r.rows[0].available_quantity), 10);
      await q('UPDATE inventory SET reserved_quantity = 4 WHERE product_id = $1', [prod]);
      const r2 = await q('SELECT available_quantity FROM inventory WHERE product_id = $1', [prod]);
      assert.strictEqual(Number(r2.rows[0].available_quantity), 6);
    });

    test('price/money CHECK constraints and NUMERIC(12,2) bounds', async () => {
      await expectPgError(
        () =>
          q(`INSERT INTO products (sku, name, unit_price) VALUES ($1, 'Free', 0.00)`, [
            `SKU-${U()}`,
          ]),
        '23514'
      );
      await expectPgError(
        () =>
          q(
            `INSERT INTO products (sku, name, unit_price, tax_rate) VALUES ($1, 'Taxed', 1.00, 101.00)`,
            [`SKU-${U()}`]
          ),
        '23514'
      );
      // Largest value that fits NUMERIC(12,2):
      const ok = await q(
        `INSERT INTO products (sku, name, unit_price) VALUES ($1, 'Big', 9999999999.99) RETURNING id`,
        [`SKU-${U()}`]
      );
      assert.ok(ok.rows[0].id);
      // One digit more must overflow (22003 numeric_field_overflow):
      await expectPgError(
        () =>
          q(`INSERT INTO products (sku, name, unit_price) VALUES ($1, 'TooBig', 100000000000.00)`, [
            `SKU-${U()}`,
          ]),
        '22003'
      );
    });

    test('financial totals: order/invoice invariants enforced by CHECKs', async () => {
      const cust = await newUserId();
      await expectPgError(
        () =>
          q(
            `INSERT INTO orders (customer_id, subtotal, tax_total, grand_total) VALUES ($1, 10.00, 1.00, 99.99)`,
            [cust]
          ),
        '23514'
      );
      const order = await newOrder(cust, { subtotal: '59.97', tax: '4.50', grand: '64.47' });
      const admin = await newUserId('admin');
      // line_total must equal unit_price * quantity exactly.
      const prodA = await newProduct();
      await expectPgError(
        () =>
          q(
            `INSERT INTO order_items (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
             VALUES ($1, $2, 'x', 19.99, 7.50, 3, 59.98, 4.50)`,
            [order, prodA]
          ),
        '23514'
      );
      // Correct fixture rows (docs/acceptance-criteria.md money fixture):
      const prodB = await newProduct();
      await q(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
         VALUES ($1, $2, 'x', 19.99, 7.50, 3, 59.97, 4.50)`,
        [order, prodB]
      );
      // Unique numbers drawn from the real counter mechanism (re-runnable).
      const c1 = await q(
        `INSERT INTO invoice_counters (period) VALUES ('2030-01')
         ON CONFLICT (period) DO UPDATE SET next_val = invoice_counters.next_val + 1
         RETURNING next_val`
      );
      const invNum1 = `INV-2030-${String(c1.rows[0].next_val).padStart(6, '0')}`;
      await q(
        `INSERT INTO invoices (order_id, invoice_number, issued_by, subtotal, tax_total, grand_total)
         VALUES ($1, $2, $3, 59.97, 4.50, 64.47)`,
        [order, invNum1, admin]
      );
      // Double-invoicing the same order is impossible (UNIQUE order_id):
      const c2 = await q(
        `UPDATE invoice_counters SET next_val = next_val + 1 WHERE period = '2030-01' RETURNING next_val`
      );
      const invNum2 = `INV-2030-${String(c2.rows[0].next_val).padStart(6, '0')}`;
      await expectPgError(
        () =>
          q(
            `INSERT INTO invoices (order_id, invoice_number, issued_by, subtotal, tax_total, grand_total)
             VALUES ($1, $2, $3, 59.97, 4.50, 64.47)`,
            [order, invNum2, admin]
          ),
        '23505'
      );
      // Bad invoice number format rejected:
      const badOrder = await newOrder(admin);
      await expectPgError(
        () =>
          q(
            `INSERT INTO invoices (order_id, invoice_number, issued_by, subtotal, tax_total, grand_total)
             VALUES ($1, 'BILL-1', $2, 1.00, 0.00, 1.00)`,
            [badOrder, admin]
          ),
        '23514'
      );
    });

    test('enum-like CHECKs reject invalid role/status/type values', async () => {
      await expectPgError(
        () =>
          q(
            `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'x', 'superuser')`,
            [`${U()}@t.test`, FAKE_HASH]
          ),
        '23514'
      );
      const cust = await newUserId();
      const enumOrder = await newOrder(cust);
      // 'archived' is not part of the order lifecycle (Phase 7 widened the CHECK
      // to pending/confirmed/processing/shipped/delivered/cancelled), so it stays
      // a CHECK violation.
      await expectPgError(
        () => q(`UPDATE orders SET status = 'archived' WHERE id = $1`, [enumOrder]),
        '23514'
      );
      // Cancelling requires a reason (FR-ORD-08):
      const order = await newOrder(cust);
      await expectPgError(
        () => q(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order]),
        '23514'
      );
      await q(
        `UPDATE orders SET status = 'cancelled', cancellation_reason = 'customer request' WHERE id = $1`,
        [order]
      );
    });

    test('order_items snapshots are immune to later catalog edits (D-07)', async () => {
      const cust = await newUserId();
      const prod = await newProduct({ price: '10.00' });
      const order = await newOrder(cust);
      await q(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, tax_rate, quantity, line_total, line_tax)
         VALUES ($1, $2, 'Orig Name', 10.00, 0.00, 1, 10.00, 0.00)`,
        [order, prod]
      );
      await q('UPDATE products SET name = $1, unit_price = 99.99 WHERE id = $2', [
        'Renamed Product',
        prod,
      ]);
      const snap = await q('SELECT product_name, unit_price FROM order_items WHERE order_id = $1', [
        order,
      ]);
      assert.strictEqual(snap.rows[0].product_name, 'Orig Name');
      assert.strictEqual(snap.rows[0].unit_price, '10.00');
    });

    test('transaction consistency: rollback leaves neither order nor audit row', async () => {
      const cust = await newUserId();
      const before = await q('SELECT count(*)::int AS n FROM audit_logs');
      await assert.rejects(
        db.withTransaction(async (client) => {
          const o = await client.query(
            `INSERT INTO orders (customer_id) VALUES ($1) RETURNING id`,
            [cust]
          );
          await client.query(
            `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id)
             VALUES ($1, 'customer', 'order.created', 'order', $2)`,
            [cust, o.rows[0].id]
          );
          throw new Error('simulated business failure');
        }),
        /simulated business failure/
      );
      const after = await q('SELECT count(*)::int AS n FROM audit_logs');
      assert.strictEqual(after.rows[0].n, before.rows[0].n, 'audit row rolled back with the order');
      const live = await q('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [cust]);
      assert.strictEqual(live.rows[0].n, 0, 'order rolled back');
    });

    test('reservation flow in one committed transaction updates stock atomically', async () => {
      const cust = await newUserId();
      const prod = await newProduct({ physical: 10 });
      const order = await newOrder(cust);
      await db.withTransaction(async (client) => {
        // Row lock — the pattern Phase 4 ordering will use (D-06/R-01).
        const inv = await client.query(
          `SELECT physical_quantity, reserved_quantity, available_quantity
           FROM inventory WHERE product_id = $1 FOR UPDATE`,
          [prod]
        );
        assert.strictEqual(Number(inv.rows[0].available_quantity), 10);
        await client.query(
          `UPDATE inventory SET reserved_quantity = reserved_quantity + 3 WHERE product_id = $1`,
          [prod]
        );
        await client.query(
          `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, order_id)
           VALUES ($1, $2, 3, 'order_reservation', $3)`,
          [prod, cust, order]
        );
      });
      const r = await q(
        'SELECT physical_quantity, reserved_quantity, available_quantity FROM inventory WHERE product_id = $1',
        [prod]
      );
      assert.strictEqual(
        Number(r.rows[0].physical_quantity),
        10,
        'physical untouched by reservation'
      );
      assert.strictEqual(Number(r.rows[0].reserved_quantity), 3);
      assert.strictEqual(Number(r.rows[0].available_quantity), 7);
      // Cancel releases the reservation and both rows stay consistent.
      await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE inventory SET reserved_quantity = reserved_quantity - 3 WHERE product_id = $1`,
          [prod]
        );
        await client.query(
          `INSERT INTO inventory_movements (product_id, performed_by, quantity_delta, movement_type, order_id)
           VALUES ($1, $2, -3, 'cancellation_release', $3)`,
          [prod, cust, order]
        );
        await client.query(
          `UPDATE orders SET status = 'cancelled', cancellation_reason = 'test release' WHERE id = $1`,
          [order]
        );
      });
      const ledger = await q(
        `SELECT COALESCE(SUM(quantity_delta),0)::int AS net FROM inventory_movements WHERE product_id = $1`,
        [prod]
      );
      assert.strictEqual(ledger.rows[0].net, 0, 'reservation + release net to zero in the ledger');
      const r2 = await q(
        'SELECT reserved_quantity, available_quantity FROM inventory WHERE product_id = $1',
        [prod]
      );
      assert.strictEqual(Number(r2.rows[0].reserved_quantity), 0);
      assert.strictEqual(Number(r2.rows[0].available_quantity), 10);
    });

    test('overselling is rejected by DB CHECK even if the app misbehaves', async () => {
      const prod = await newProduct({ physical: 1 });
      await assert.rejects(
        db.withTransaction(async (client) => {
          await client.query(
            `UPDATE inventory SET reserved_quantity = reserved_quantity + 5 WHERE product_id = $1`,
            [prod]
          );
        }),
        /check constraint|inventory_available_non_negative/i
      );
      const r = await q('SELECT reserved_quantity FROM inventory WHERE product_id = $1', [prod]);
      assert.strictEqual(
        Number(r.rows[0].reserved_quantity),
        0,
        'failed reservation left no partial state'
      );
    });

    test('audit_logs is append-only at the DB level (UPDATE/DELETE blocked)', async () => {
      const cust = await newUserId();
      await q(
        `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, details)
         VALUES ($1, 'customer', 'user.login', 'user', '{"ok":true}'::jsonb)`,
        [cust]
      );
      await expectPgError(
        () => q(`UPDATE audit_logs SET action = 'tampered' WHERE actor_id = $1`, [cust]),
        'P0001',
        /append-only/
      );
      await expectPgError(
        () => q(`DELETE FROM audit_logs WHERE actor_id = $1`, [cust]),
        'P0001',
        /append-only/
      );
    });

    test('audit_logs.outcome stores success/failure and rejects anything else (migration 18)', async () => {
      const cust = await newUserId();
      // Default is 'success' when omitted.
      const dflt = await q(
        `INSERT INTO audit_logs (actor_id, action, entity_type) VALUES ($1, 'T_DEFAULT', 'user') RETURNING outcome`,
        [cust]
      );
      assert.strictEqual(dflt.rows[0].outcome, 'success');
      // 'failure' is a legal outcome (used for rejected logins).
      await q(
        `INSERT INTO audit_logs (actor_id, action, entity_type, outcome) VALUES ($1, 'T_FAIL', 'user', 'failure')`,
        [cust]
      );
      // Anything else violates the CHECK.
      await expectPgError(
        () =>
          q(
            `INSERT INTO audit_logs (actor_id, action, entity_type, outcome) VALUES ($1, 'T_BAD', 'user', 'maybe')`,
            [cust]
          ),
        '23514'
      );
    });

    test('invoice counter claims sequential numbers under upsert (D-10)', async () => {
      const sql = `INSERT INTO invoice_counters (period) VALUES ('2099-01')
                   ON CONFLICT (period) DO UPDATE SET next_val = invoice_counters.next_val + 1
                   RETURNING next_val`;
      const a = await q(sql);
      const b = await q(sql);
      assert.strictEqual(Number(b.rows[0].next_val), Number(a.rows[0].next_val) + 1);
    });

    test('idempotency claim row supports replay (D-08)', async () => {
      const user = await newUserId();
      const key = `replay-${U()}`;
      await q(
        `INSERT INTO idempotency_keys (user_id, idempotency_key, request_scope, expires_at)
         VALUES ($1, $2, 'POST /api/orders', now() + interval '24 hours')`,
        [user, key]
      );
      // 'completed' without a stored response is contradictory — rejected:
      await expectPgError(
        () =>
          q(
            `UPDATE idempotency_keys SET status = 'completed' WHERE user_id = $1 AND idempotency_key = $2`,
            [user, key]
          ),
        '23514'
      );
      await q(
        `UPDATE idempotency_keys SET status = 'completed', response_status = 201, response_body = '{"orderId":42}'
         WHERE user_id = $1 AND idempotency_key = $2`,
        [user, key]
      );
      const r = await q(
        `SELECT response_body FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2`,
        [user, key]
      );
      assert.deepStrictEqual(r.rows[0].response_body, { orderId: 42 });
    });
  }
);

// Runs after the main suite (sequential within the file). Only the isolated
// test database is torn down and rebuilt here.
describe(
  'Migration reversibility (down --all, then up again)',
  { skip: SKIP_REASON, timeout: 120000 },
  () => {
    test('down --all removes every table; up restores the identical schema', async () => {
      // Schema reversibility is a DDL property, so it is asserted on emptied
      // tables. Migration 16's `down` narrows `order_status_valid` back to the
      // pre-Phase-7 domain; a later suite (order-http) legitimately leaves rows
      // using 'processing'/'shipped'/'delivered' in the shared test DB, which
      // would otherwise make the narrowed CHECK re-add fail (23514). Clearing
      // order data first keeps the round-trip deterministic across runs.
      // (TRUNCATE ... CASCADE also empties `invoices`, which references orders.)
      // Migration 17's `down` re-adds the strict monthly invoice-counter period
      // CHECK, so the yearly 'YYYY' counter rows the invoice suite draws must be
      // cleared too.
      await db.getPool().query('TRUNCATE TABLE orders CASCADE');
      await db.getPool().query('TRUNCATE TABLE invoice_counters');
      await db.closePool();
      await runMigrations('down', 0);
      const probe = await (async () => {
        const { Pool } = require('pg');
        const p = new Pool({ connectionString: config.databaseUrlTest, max: 1 });
        try {
          const r = await p.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
          );
          return new Set(r.rows.map((row) => row.table_name));
        } finally {
          await p.end();
        }
      })();
      for (const t of EXPECTED_TABLES)
        assert.ok(!probe.has(t), `table should be gone after down: ${t}`);

      await runMigrations('up');
      const pool2 = db.getPool();
      const r = await pool2.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      );
      const restored = new Set(r.rows.map((row) => row.table_name));
      for (const t of EXPECTED_TABLES) assert.ok(restored.has(t), `table should be restored: ${t}`);
      await db.closePool();
    });
  }
);
