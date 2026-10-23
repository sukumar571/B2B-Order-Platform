'use strict';

/**
 * Phase 8 — invoice integration tests.
 * Runs ONLY against the isolated DATABASE_URL_TEST database and ONLY via
 * `npm run test:integration` (B2B_RUN_DB_TESTS=1). Plain `npm test` skips it.
 *
 * Covers the Must-level invoice acceptance criteria end to end: the invoice is
 * minted atomically on the `→ shipped` transition and NOT before (FR-INV-01 /
 * AC-INV-01), carries the order's persisted snapshot totals exactly (AC-INV-01),
 * is numbered INV-YYYY-NNNNNN and strictly increasing within a year (FR-INV-02 /
 * AC-INV-02), can never be duplicated for one order (FR-INV-05 / AC-INV-03),
 * is ownership-scoped (customers own-only, staff all — FR-INV-04 / AC-INV-04),
 * supports a totals-preserving staff void, leaves cancelled orders uninvoiced,
 * and is immune to later catalog edits (SC-04).
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
const SKIP_REASON = ENABLED
  ? false
  : 'isolated test DB required — run: npm run test:integration (uses DATABASE_URL_TEST only)';

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
  const email = `${role}-${U()}.invoice.test`;
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, '$2b$12$notarealhashnotarealhashnotarealhashnotareah', $2, $3)
     RETURNING id`,
    [email, `Test ${role}`, role]
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

function place(token, body, key) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body || {});
}

const patchStatus = (token, id, status) =>
  request(app)
    .patch(`/api/orders/${id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status });

const getOrderInvoice = (token, orderId) =>
  request(app).get(`/api/orders/${orderId}/invoice`).set('Authorization', `Bearer ${token}`);

const getInvoice = (token, id) =>
  request(app).get(`/api/invoices/${id}`).set('Authorization', `Bearer ${token}`);

/** Place an order for one product/qty and drive it through to `shipped`. */
async function shipOrder(agentToken, customerToken, productId, quantity) {
  const created = await place(
    customerToken,
    { items: [{ product_id: productId, quantity }] },
    KEY()
  );
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const order = created.body;
  for (const status of ['confirmed', 'processing', 'shipped']) {
    const r = await patchStatus(agentToken, order.id, status);
    assert.strictEqual(r.status, 200, `${status}: ${JSON.stringify(r.body)}`);
  }
  return order;
}

describe('Invoices over HTTP (isolated test DB)', { skip: SKIP_REASON, timeout: 240000 }, () => {
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

  // ── Access control ────────────────────────────────────────────────────────
  test('invoice reads require authentication (anon 401)', async () => {
    assert.strictEqual((await request(app).get('/api/invoices')).status, 401);
    assert.strictEqual((await request(app).get('/api/invoices/1')).status, 401);
    assert.strictEqual((await request(app).get('/api/orders/1/invoice')).status, 401);
  });

  // ── Generated on SHIP, not before (FR-INV-01 / AC-INV-01) ──────────────────
  test('no invoice exists until the order ships, then it appears atomically', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `When${U()}`,
      unit_price: '19.99',
      tax_rate: '7.5',
      initial_stock: 10,
    });
    const created = await place(c.token, { items: [{ product_id: p.id, quantity: 2 }] }, KEY());
    const order = created.body;

    // Pre-shipment states have NO invoice.
    assert.strictEqual(
      (await getOrderInvoice(c.token, order.id)).status,
      404,
      'pending has no invoice'
    );
    await patchStatus(agent.token, order.id, 'confirmed');
    assert.strictEqual(
      (await getOrderInvoice(c.token, order.id)).status,
      404,
      'confirmed has no invoice'
    );
    await patchStatus(agent.token, order.id, 'processing');
    assert.strictEqual(
      (await getOrderInvoice(c.token, order.id)).status,
      404,
      'processing has no invoice'
    );

    // Ship → the invoice is minted in the same transaction.
    const shipped = await patchStatus(agent.token, order.id, 'shipped');
    assert.strictEqual(shipped.status, 200);

    const inv = await getOrderInvoice(c.token, order.id);
    assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
    const body = inv.body;
    assert.strictEqual(body.order_id, order.id);
    assert.strictEqual(body.status, 'issued');
    // Totals equal the ORDER SNAPSHOT exactly (19.99×2@7.5 → 39.98/3.00/42.98).
    assert.strictEqual(body.subtotal, order.subtotal);
    assert.strictEqual(body.tax_total, order.tax_total);
    assert.strictEqual(body.grand_total, order.grand_total);
    assert.strictEqual(body.subtotal, '39.98');
    assert.strictEqual(body.tax_total, '3.00');
    assert.strictEqual(body.grand_total, '42.98');
    assert.strictEqual(Number(body.subtotal) + Number(body.tax_total), Number(body.grand_total));
    // Professional/document fields present.
    assert.match(body.invoice_number, /^INV-\d{4}-\d{6}$/);
    assert.ok(body.items.length >= 1);
    assert.strictEqual(body.items[0].line_total, '39.98');
    assert.ok(body.customer && body.customer.id === String(c.id));
    assert.ok(body.distributor && body.distributor.name);
    assert.strictEqual(body.demo, true);
    assert.match(body.demo_notice, /DEMONSTRATION DOCUMENT/i);
  });

  // ── Numbering monotonic within a year (FR-INV-02 / AC-INV-02) ──────────────
  test('consecutive shipped orders get strictly increasing yearly numbers', async () => {
    const year = new Date().getUTCFullYear();
    const p = await createProduct(admin, { name: `Num${U()}`, initial_stock: 20 });
    const i1 = await getOrderInvoice(
      customer.token,
      (await shipOrder(agent.token, customer.token, p.id, 1)).id
    );
    const i2 = await getOrderInvoice(
      customer.token,
      (await shipOrder(agent.token, customer.token, p.id, 1)).id
    );
    assert.strictEqual(i1.status, 200);
    assert.strictEqual(i2.status, 200);
    assert.ok(i1.body.invoice_number.startsWith(`INV-${year}-`));
    const s1 = Number(i1.body.invoice_number.slice(-6));
    const s2 = Number(i2.body.invoice_number.slice(-6));
    assert.ok(s2 > s1, `sequence must increase: ${s1} → ${s2}`);
    assert.notStrictEqual(i1.body.invoice_number, i2.body.invoice_number);
  });

  // ── One invoice per order, DB-enforced (FR-INV-05 / AC-INV-03) ─────────────
  test('a second invoice for the same order is rejected by the UNIQUE constraint', async () => {
    const p = await createProduct(admin, { name: `Dup${U()}`, initial_stock: 20 });
    const order = await shipOrder(agent.token, customer.token, p.id, 1);
    // The service already created exactly one; a raw duplicate must be refused.
    const existing = await db.query('SELECT id FROM invoices WHERE order_id = $1', [order.id]);
    assert.strictEqual(existing.rows.length, 1, 'exactly one invoice via the service');
    const r = await db.query('SELECT count(*)::int AS n FROM invoices WHERE order_id = $1', [
      order.id,
    ]);
    assert.strictEqual(r.rows[0].n, 1);
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO invoices (order_id, invoice_number, issued_by, subtotal, tax_total, grand_total)
           VALUES ($1, 'INV-2099-000001', $2, 1.00, 0.00, 1.00)`,
          [order.id, admin.id]
        ),
      (err) => err.code === '23505'
    );
  });

  // ── Ownership scoping (FR-INV-04 / AC-INV-04) ──────────────────────────────
  test('customers see only their own invoices; staff see all', async () => {
    const a = await makeUser('customer');
    const b = await makeUser('customer');
    const p = await createProduct(admin, { name: `Scope${U()}`, initial_stock: 50 });
    const aOrder = await shipOrder(agent.token, a.token, p.id, 1);

    const aInv = await getOrderInvoice(a.token, aOrder.id);
    assert.strictEqual(aInv.status, 200);

    // Another customer cannot resolve it (404, never 403 — no existence leak).
    assert.strictEqual((await getOrderInvoice(b.token, aOrder.id)).status, 404);
    assert.strictEqual((await getInvoice(b.token, aInv.body.id)).status, 404);

    const aList = await request(app).get('/api/invoices').set('Authorization', `Bearer ${a.token}`);
    assert.strictEqual(aList.status, 200);
    assert.ok(aList.body.data.every((x) => x.customer_id === String(a.id)));
    assert.ok(aList.body.data.some((x) => x.id === aInv.body.id));

    const staff = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${admin.token}`);
    assert.ok(staff.body.data.length >= 1, 'staff see invoices');
  });

  // ── Void: totals-preserving, staff-only, single (FR-INV / D-25) ────────────
  test('admin voids an invoice (row preserved) and a re-void is refused; customer cannot void', async () => {
    const p = await createProduct(admin, { name: `Void${U()}`, initial_stock: 20 });
    const c = await makeUser('customer');
    const order = await shipOrder(agent.token, c.token, p.id, 2);
    const inv = (await getOrderInvoice(c.token, order.id)).body;

    // Customer void is forbidden (staff-only route).
    const custVoid = await request(app)
      .post(`/api/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ reason: 'not allowed' });
    assert.strictEqual(custVoid.status, 403);

    // Admin void succeeds; totals and lines are PRESERVED.
    const voided = await request(app)
      .post(`/api/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'goods returned' });
    assert.strictEqual(voided.status, 200, JSON.stringify(voided.body));
    assert.strictEqual(voided.body.status, 'voided');
    assert.strictEqual(voided.body.void_reason, 'goods returned');
    assert.strictEqual(voided.body.grand_total, inv.grand_total, 'void never changes totals');
    assert.ok(voided.body.items.length >= 1, 'line history preserved');

    // Re-void → 409.
    const again = await request(app)
      .post(`/api/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'again' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.error.code, 'INVALID_STATE_TRANSITION');

    const audit = await db.query(
      `SELECT action FROM audit_logs WHERE entity_type='invoice' AND entity_id=$1`,
      [inv.id]
    );
    assert.ok(audit.rows.some((r) => r.action === 'INVOICE_VOIDED'));
  });

  // ── Cancelled orders are never invoiced ────────────────────────────────────
  test('a cancelled order has no invoice', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, { name: `Cxl${U()}`, initial_stock: 20 });
    const created = await place(c.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY());
    const order = created.body;
    const cancel = await request(app)
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ reason: 'changed my mind' });
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual((await getOrderInvoice(c.token, order.id)).status, 404);
    const list = await request(app).get('/api/invoices').set('Authorization', `Bearer ${c.token}`);
    assert.ok(!list.body.data.some((x) => x.order_id === order.id));
  });

  // ── Snapshot immutability (SC-04) ──────────────────────────────────────────
  test('invoice totals and lines are immune to later catalog price edits', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Immut${U()}`,
      unit_price: '12.00',
      tax_rate: '0',
      initial_stock: 20,
    });
    const order = await shipOrder(agent.token, c.token, p.id, 2);
    const inv = (await getOrderInvoice(c.token, order.id)).body;
    assert.strictEqual(inv.items[0].unit_price, '12.00');
    assert.strictEqual(inv.grand_total, '24.00');

    await request(app)
      .patch(`/api/products/${p.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ unit_price: '999.00', name: 'Renamed' });

    const after = await getInvoice(c.token, inv.id);
    assert.strictEqual(after.body.items[0].unit_price, '12.00', 'stored price unchanged');
    assert.strictEqual(after.body.items[0].product_name, inv.items[0].product_name);
    assert.strictEqual(after.body.grand_total, '24.00');
  });

  // ── Invalid access + validation ────────────────────────────────────────────
  test('unknown invoice id → 404; malformed id / bad status filter → 400', async () => {
    assert.strictEqual((await getInvoice(admin.token, '999999999')).status, 404);
    assert.strictEqual((await getInvoice(admin.token, 'abc')).status, 400);
    const bad = await request(app)
      .get('/api/invoices?status=nope')
      .set('Authorization', `Bearer ${admin.token}`);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error.code, 'VALIDATION_ERROR');
  });

  test('void requires a meaningful reason (strict, 3–500 chars)', async () => {
    const p = await createProduct(admin, { name: `Why${U()}`, initial_stock: 20 });
    const order = await shipOrder(agent.token, customer.token, p.id, 1);
    const inv = (await getOrderInvoice(customer.token, order.id)).body;
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'x' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
  });
});
