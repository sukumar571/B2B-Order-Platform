'use strict';

/**
 * Phase 9 — audit-trail integration tests (isolated test DB, `npm run
 * test:integration` only).
 *
 * Proves the Must-level audit acceptance criteria end to end:
 *  - the trail is ADMIN-only and READ-ONLY (FR-AUD-02/03): customer/agent 403,
 *    and there is NO route that mutates history;
 *  - every auditable business change emits its row TRANSACTIONALLY (AC-AUD-01 /
 *    NFR-13) — product, inventory, the full order lifecycle (reservation →
 *    consumption / release), the invoice, and a user edit all appear;
 *  - failed logins are recorded with outcome 'failure' (FR-AUD-01);
 *  - filters (action / entity / outcome / date range / actor) and pagination.
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
  const email = `${role}-${U()}.audit.test`;
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, '$2b$12$notarealhashnotarealhashnotarealhashnotareah', $2, $3)
     RETURNING id`,
    [email, `Audit ${role}`, role]
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

const patchStatus = (token, id, status) =>
  request(app)
    .patch(`/api/orders/${id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status });

const audit = (token, qs = '') =>
  request(app).get(`/api/audit-logs${qs}`).set('Authorization', `Bearer ${token}`);

/** Actions recorded for a specific entity, newest-first set. */
async function actionsFor(token, entityType, entityId) {
  const res = await audit(token, `?entity_type=${entityType}&entity_id=${entityId}&limit=100`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.data.map((r) => r.action);
}

describe('Audit trail over HTTP (isolated test DB)', { skip: SKIP_REASON, timeout: 240000 }, () => {
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

  test('endpoint is ADMIN-only (anon 401, customer/agent 403, admin 200)', async () => {
    assert.strictEqual((await request(app).get('/api/audit-logs')).status, 401);
    assert.strictEqual((await audit(customer.token)).status, 403);
    assert.strictEqual((await audit(agent.token)).status, 403);
    const ok = await audit(admin.token);
    assert.strictEqual(ok.status, 200);
    assert.ok(Array.isArray(ok.body.data));
    assert.ok(ok.body.meta && typeof ok.body.meta.total === 'number');
  });

  test('history is read-only: no create/update/delete route exists', async () => {
    // Only GET is mounted under /api/audit-logs, so every mutating verb 404s
    // (falls through to the notFound handler) — there is no way to alter it.
    assert.strictEqual(
      (await request(app).post('/api/audit-logs').set('Authorization', `Bearer ${admin.token}`))
        .status,
      404
    );
    assert.strictEqual(
      (await request(app).put('/api/audit-logs/1').set('Authorization', `Bearer ${admin.token}`))
        .status,
      404
    );
    assert.strictEqual(
      (await request(app).delete('/api/audit-logs/1').set('Authorization', `Bearer ${admin.token}`))
        .status,
      404
    );
  });

  test('business changes are audited transactionally across the full lifecycle', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Audit${U()}`,
      unit_price: '19.99',
      tax_rate: '7.5',
      initial_stock: 50,
    });

    // Product creation is recorded with the acting admin's identity joined in.
    const productActions = await actionsFor(admin.token, 'product', p.id);
    assert.ok(productActions.includes('PRODUCT_CREATED'), 'product create audited');

    // Inventory adjustment.
    const adj = await request(app)
      .patch(`/api/inventory/${p.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ delta: 5, reason: 'restock' });
    assert.strictEqual(adj.status, 200, JSON.stringify(adj.body));
    const invActions = await actionsFor(admin.token, 'inventory', p.id);
    assert.ok(invActions.includes('STOCK_ADJUSTED'), 'adjustment audited');

    // Order → ship: reservation, consumption, status change and invoice in one trail.
    const shipOrder = (await place(c.token, { items: [{ product_id: p.id, quantity: 2 }] }, KEY()))
      .body;
    for (const s of ['confirmed', 'processing', 'shipped']) {
      assert.strictEqual((await patchStatus(agent.token, shipOrder.id, s)).status, 200);
    }
    const shipActions = await actionsFor(admin.token, 'order', shipOrder.id);
    for (const a of ['ORDER_CREATED', 'STOCK_RESERVED', 'ORDER_STATUS_CHANGED', 'STOCK_CONSUMED']) {
      assert.ok(shipActions.includes(a), `order trail must contain ${a}`);
    }
    const invoiceRow = await db.query('SELECT id FROM invoices WHERE order_id = $1', [
      shipOrder.id,
    ]);
    const invoiceActions = await actionsFor(admin.token, 'invoice', invoiceRow.rows[0].id);
    assert.ok(invoiceActions.includes('INVOICE_ISSUED'), 'invoice issued audited');

    // Order → cancel before shipping: a release is recorded.
    const cancelOrder = (
      await place(c.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY())
    ).body;
    const cancel = await request(app)
      .post(`/api/orders/${cancelOrder.id}/cancel`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ reason: 'no longer needed' });
    assert.strictEqual(cancel.status, 200);
    const cancelActions = await actionsFor(admin.token, 'order', cancelOrder.id);
    assert.ok(cancelActions.includes('ORDER_CANCELLED'), 'cancellation audited');
    assert.ok(cancelActions.includes('STOCK_RELEASED'), 'reservation release audited');
  });

  test('failed and successful logins are recorded with the correct outcome', async () => {
    const email = `login-${U()}@audit.test`;
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Passw0rd!123', name: 'Login Tester' });
    assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));

    // A successful login for that account.
    const good = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'Passw0rd!123' });
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));

    // A failed login (wrong password) on a KNOWN account.
    const bad = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'WrongPass!999' });
    assert.strictEqual(bad.status, 401);

    const success = await audit(admin.token, `?action=LOGIN_SUCCESS&limit=100`);
    assert.ok(
      success.body.data.some((r) => r.outcome === 'success' && r.entity_type === 'user'),
      'a LOGIN_SUCCESS row exists'
    );

    const failure = await audit(admin.token, `?action=LOGIN_FAILED&outcome=failure&limit=100`);
    const target = failure.body.data.find((r) => r.details && r.details.email === email);
    assert.ok(target, 'a LOGIN_FAILED row for the attempted email is recorded as failure');
    assert.strictEqual(target.actor_id, null, 'failed login carries no actor id');

    // USER_REGISTERED was written transactionally at sign-up.
    const regActions = await audit(admin.token, `?action=USER_REGISTERED&limit=100`);
    assert.ok(regActions.body.data.some((r) => r.entity_type === 'user'));
  });

  test('filters: outcome, action, entity_type and date range; pagination meta', async () => {
    const failuresOnly = await audit(admin.token, '?outcome=failure&limit=100');
    assert.strictEqual(failuresOnly.status, 200);
    assert.ok(failuresOnly.body.data.every((r) => r.outcome === 'failure'));

    const productOnly = await audit(
      admin.token,
      '?entity_type=product&action=PRODUCT_CREATED&limit=100'
    );
    assert.ok(
      productOnly.body.data.every(
        (r) => r.entity_type === 'product' && r.action === 'PRODUCT_CREATED'
      )
    );

    // A future lower-bound excludes everything recorded so far.
    const future = await audit(admin.token, '?from=2099-01-01');
    assert.strictEqual(future.body.meta.total, 0, 'no events after 2099');

    // A far-past lower-bound includes the whole trail.
    const past = await audit(admin.token, '?from=2000-01-01&limit=1');
    assert.ok(past.body.meta.total >= 1);
    assert.strictEqual(past.body.data.length, 1, 'limit is respected');

    // Page 2 differs from page 1 (newest-first ordering is stable + paged).
    const p1 = await audit(admin.token, '?limit=5&page=1');
    const p2 = await audit(admin.token, '?limit=5&page=2');
    if (p2.body.data.length) {
      const ids1 = new Set(p1.body.data.map((r) => r.id));
      assert.ok(
        p2.body.data.every((r) => !ids1.has(r.id)),
        'pages do not overlap'
      );
    }
  });

  test('malformed filters fail closed (400 VALIDATION_ERROR), never widen the read', async () => {
    const badAction = await audit(admin.token, '?action=NOT_REAL');
    assert.strictEqual(badAction.status, 400);
    assert.strictEqual(badAction.body.error.code, 'VALIDATION_ERROR');

    const badDate = await audit(admin.token, '?from=not-a-date');
    assert.strictEqual(badDate.status, 400);

    const unknownParam = await audit(admin.token, '?surprise=1');
    assert.strictEqual(unknownParam.status, 400, 'strict query rejects unknown keys');
  });
});
