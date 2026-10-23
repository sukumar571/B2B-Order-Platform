'use strict';

/**
 * Phase 9 — dashboard/report integration tests (isolated test DB).
 *
 * Aggregation ACCURACY is proven against a self-contained time window: the test
 * captures `from = now`, then creates a known set of orders, so the window
 * contains EXACTLY those orders (suites are serialized with --test-concurrency=1
 * and this file is the only one running). This gives deterministic totals without
 * depending on rows left by earlier suites.
 *
 * Also proves: the full dashboard is ADMIN-only, the order-summary/low-stock
 * reports are the staff view, customers are refused both, and NO revenue figure
 * is ever reported (order value is booked demand, not money collected).
 */

process.env.NODE_ENV = 'test';

const path = require('node:path');
const crypto = require('node:crypto');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const config = require('../src/config/env');
const db = require('../src/db/pool');
const pm = require('node-pg-migrate');
const migrate = pm.default || pm.migrate || pm;
const { createApp } = require('../src/app');
const tokenService = require('../src/services/token.service');

const ENABLED = Boolean(config.databaseUrlTest) && process.env.B2B_RUN_DB_TESTS === '1';
const SKIP_REASON = ENABLED ? false : 'isolated test DB required — run: npm run test:integration';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
function runMigrations(direction) {
  return migrate({
    direction,
    databaseUrl: config.databaseUrlTest,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    verbose: false,
    log: () => {},
  });
}

let seq = 0;
const U = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const SKU = () => `SKU-${U()}`;
const KEY = () => crypto.randomUUID();

const app = createApp();

async function makeUser(role = 'customer') {
  const email = `${role}-${U()}.report.test`;
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, '$2b$12$notarealhashnotarealhashnotarealhashnotareah', $2, $3)
     RETURNING id`,
    [email, `Report ${role}`, role]
  );
  const id = r.rows[0].id;
  const token = tokenService.signAccessToken({ userId: id, role });
  return { id, email, token };
}

async function createProduct(admin, fields) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ sku: SKU(), name: 'Generic', unit_price: '10.00', tax_rate: '0', ...fields });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const place = (token, body, key) =>
  request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body || {});

const get = (token, url) => request(app).get(url).set('Authorization', `Bearer ${token}`);

describe(
  'Reports & dashboard over HTTP (isolated test DB)',
  { skip: SKIP_REASON, timeout: 240000 },
  () => {
    let admin;
    let agent;
    let customer;

    before(async () => {
      await runMigrations('up');
      await db.getPool().query('SELECT 1');
      admin = await makeUser('admin');
      agent = await makeUser('agent');
      customer = await makeUser('customer');
    });

    after(async () => {
      await db.closePool();
    });

    test('access control: dashboard ADMIN-only, summary/low-stock staff-only, customer refused', async () => {
      assert.strictEqual((await request(app).get('/api/reports/dashboard')).status, 401);
      // Full dashboard (embeds the audit feed) is ADMIN only.
      assert.strictEqual((await get(agent.token, '/api/reports/dashboard')).status, 403);
      assert.strictEqual((await get(customer.token, '/api/reports/dashboard')).status, 403);
      assert.strictEqual((await get(admin.token, '/api/reports/dashboard')).status, 200);

      // Order managers get the scoped summary + low-stock, not the audit dashboard.
      assert.strictEqual((await get(agent.token, '/api/reports/order-summary')).status, 200);
      assert.strictEqual((await get(agent.token, '/api/reports/low-stock')).status, 200);
      assert.strictEqual((await get(customer.token, '/api/reports/order-summary')).status, 403);
      assert.strictEqual((await get(customer.token, '/api/reports/low-stock')).status, 403);
    });

    test('the agent order-summary never carries the audit feed', async () => {
      const res = await get(agent.token, '/api/reports/order-summary');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.audience, 'order_manager');
      assert.strictEqual(res.body.data.audit, undefined, 'agents must not receive audit data');
      const dash = await get(admin.token, '/api/reports/dashboard');
      assert.ok(dash.body.data.audit && Array.isArray(dash.body.data.audit.recent_activity));
    });

    test('aggregation accuracy on an isolated window (order value excludes cancelled, is not revenue)', async () => {
      const from = new Date(Date.now() - 1000).toISOString(); // window starts ~now
      const c = await makeUser('customer');

      const pA = await createProduct(admin, {
        name: `RptA${U()}`,
        unit_price: '10.00',
        tax_rate: '0',
        initial_stock: 10,
      });
      const pB = await createProduct(admin, {
        name: `RptB${U()}`,
        unit_price: '20.00',
        tax_rate: '0',
        initial_stock: 10,
      });

      // Order A: 10.00, kept live (shipped so it is definitely non-cancelled).
      const orderA = (await place(c.token, { items: [{ product_id: pA.id, quantity: 1 }] }, KEY()))
        .body;
      await request(app)
        .patch(`/api/orders/${orderA.id}/status`)
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ status: 'confirmed' });

      // Order B: 20.00, then cancelled (must NOT count toward booked value).
      const orderB = (await place(c.token, { items: [{ product_id: pB.id, quantity: 1 }] }, KEY()))
        .body;
      const cancel = await request(app)
        .post(`/api/orders/${orderB.id}/cancel`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ reason: 'test cancellation' });
      assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));

      const q = `?from=${encodeURIComponent(from)}`;
      const res = await get(admin.token, `/api/reports/dashboard${q}`);
      assert.strictEqual(res.status, 200);
      const d = res.body.data;

      // Exactly the two orders created inside this window.
      assert.strictEqual(d.totals.total_orders, 2, 'two orders in the window');
      assert.strictEqual(d.totals.cancelled_orders, 1, 'one cancelled');
      assert.strictEqual(d.totals.active_orders, 1, 'one live');
      assert.strictEqual(
        Number(d.totals.booked_order_value),
        10,
        'booked value excludes the cancelled order'
      );
      assert.strictEqual(
        Number(d.totals.gross_value_including_cancelled),
        30,
        'gross includes all'
      );

      // Status breakdown sums to the window total.
      const statusSum = Object.values(d.orders_by_status).reduce((a, b) => a + b, 0);
      assert.strictEqual(statusSum, d.totals.total_orders, 'breakdown reconciles to total');
      assert.strictEqual(d.orders_by_status.cancelled, 1);

      // Honest labelling: order value is booked demand, not revenue; no revenue figure.
      assert.match(d.metric_definitions.booked_order_value, /not .*revenue/i);
      assert.ok(d.metric_definitions.limitations, 'limitations documented in the payload');
      assert.strictEqual(d.revenue, undefined, 'no revenue metric is fabricated');
      assert.ok(
        !Object.keys(d.totals).some((k) => /revenue|sales|collected/i.test(k)),
        'totals carry no revenue key'
      );

      // A future window legitimately contains nothing — proves the filter works.
      const empty = await get(admin.token, '/api/reports/dashboard?from=2099-01-01');
      assert.strictEqual(empty.body.data.totals.total_orders, 0);
    });

    test('low-stock report is paginated and every row is genuinely low', async () => {
      // Create a product below its threshold so the report has real content.
      await createProduct(admin, { name: `Low${U()}`, initial_stock: 1, low_stock_threshold: 20 });
      const res = await get(admin.token, '/api/reports/low-stock?limit=5');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.meta && typeof res.body.meta.total === 'number');
      assert.ok(res.body.data.length <= 5);
      assert.ok(
        res.body.data.every((r) => r.available_quantity <= r.low_stock_threshold),
        'only low-stock rows returned'
      );
    });

    test('bad window params fail closed (400)', async () => {
      const bad = await get(admin.token, '/api/reports/dashboard?from=yesterday');
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.error.code, 'VALIDATION_ERROR');
    });
  }
);
