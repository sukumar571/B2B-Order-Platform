'use strict';

/**
 * Phase 11 — SECURITY & EDGE-CASE integration suite.
 * Runs ONLY against the isolated DATABASE_URL_TEST database and ONLY via
 * `npm run test:integration` (B2B_RUN_DB_TESTS=1). Plain `npm test` skips it.
 *
 * Focused on the hardening checklist: malformed input, size limits, authn/
 * authz matrices, cross-customer IDOR (orders, carts, invoices), invalid
 * status transitions, insufficient stock, concurrent ordering, the same-order
 * transition race fixed in Phase 11 (SELECT … FOR UPDATE on the orders row),
 * duplicate submission, and DB-level last-line defenses (CHECK constraints,
 * append-only audit trigger, transaction rollback atomicity).
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
const U = () => `sec${Date.now().toString(36)}${(seq++).toString(36)}`;
const SKU = () => `SEC-SKU-${U()}`;
const KEY = () => crypto.randomUUID();
const nextBucket = () => `sec-bucket-${U()}`;

const app = createApp();

async function makeUser(role = 'customer') {
  const email = `${role}-${U()}@security.test`;
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, '$2b$12$notarealhashnotarealhashnotarealhashnotareah', $2, $3)
     RETURNING id`,
    [email, `Sec ${role}`, role]
  );
  const id = r.rows[0].id;
  const token = tokenService.signAccessToken({ userId: id, role });
  return { id, email, token };
}

async function createProduct(admin, fields) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ sku: SKU(), name: 'Security Probe', unit_price: '10.00', tax_rate: '0', ...fields });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const auth = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

function place(token, body, key) {
  let req = request(app).post('/api/orders');
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (key !== undefined) req = req.set('Idempotency-Key', key);
  return req.send(body || {});
}

const patchStatus = (token, orderId, status) =>
  request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status });

const cancel = (token, orderId, reason = 'security test cancel') =>
  request(app)
    .post(`/api/orders/${orderId}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason });

async function stockRow(productId) {
  const r = await db.query(
    'SELECT physical_quantity, reserved_quantity, available_quantity FROM inventory WHERE product_id = $1',
    [productId]
  );
  return r.rows[0];
}

async function auditCount(action, entityId) {
  const r = await db.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND entity_id = $2 AND entity_type = 'order'",
    [action, entityId]
  );
  return r.rows[0].n;
}

/** pending → confirmed → processing (one PATCH per legal step). */
async function advanceTo(token, orderId, target) {
  const chain = ['confirmed', 'processing', 'shipped'];
  for (const step of chain) {
    const res = await patchStatus(token, orderId, step);
    assert.strictEqual(
      res.status,
      200,
      `advance ${orderId} → ${step}: ${JSON.stringify(res.body)}`
    );
    if (step === target) return;
  }
}

describe(
  'Security & edge cases over HTTP (isolated test DB)',
  {
    skip: SKIP_REASON,
    timeout: 300000,
  },
  () => {
    let admin;
    let agent;
    let customerA;
    let customerB;

    before(async () => {
      await runMigrations('up');
      await db.getPool().query('SELECT 1');
      admin = await makeUser('admin');
      agent = await makeUser('agent');
      customerA = await makeUser('customer');
      customerB = await makeUser('customer');
    });

    after(async () => {
      await db.closePool();
    });

    // ── Malformed / oversized requests ────────────────────────────────────────
    test('malformed JSON bodies → 400 INVALID_JSON (never 500, never a stack)', async () => {
      for (const pathName of ['/api/auth/login', '/api/orders', '/api/cart/items']) {
        const res = await request(app)
          .post(pathName)
          .set(auth(customerA.token))
          .set('Content-Type', 'application/json')
          .send('{"items": [ this is not valid json');
        assert.strictEqual(res.status, 400, `${pathName}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error.code, 'INVALID_JSON');
        assert.ok(!/at .*node_modules|stack/i.test(JSON.stringify(res.body)), 'stack leaked');
      }
    });

    test('valid JSON of the wrong shape (array) → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/cart/items')
        .set(auth(customerA.token))
        .send([{ product_id: 1, quantity: 1 }]);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
    });

    test('oversized bodies → 413 PAYLOAD_TOO_LARGE under the configured limit', async () => {
      const huge = 'x'.repeat(150 * 1024);
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Test-Bucket', nextBucket())
        .send({ email: `oversize-${U()}@security.test`, password: huge });
      assert.strictEqual(res.status, 413, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.code, 'PAYLOAD_TOO_LARGE');
    });

    // ── Invalid identifiers ───────────────────────────────────────────────────
    test('non-numeric / non-positive / fractional ids → 400; unknown ids → 404', async () => {
      for (const bad of ['abc', '0', '-5', '1.5', 'null', '1e9x']) {
        const res = await request(app).get(`/api/orders/${bad}`).set(auth(customerA.token));
        assert.strictEqual(
          res.status,
          400,
          `id '${bad}' → ${res.status}: ${JSON.stringify(res.body)}`
        );
        assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
      }
      for (const bad of ['abc', '-1']) {
        const res = await request(app).get(`/api/invoices/${bad}`).set(auth(customerA.token));
        assert.strictEqual(res.status, 400, `invoice id '${bad}' → ${res.status}`);
      }
      const ghost = await request(app).get('/api/orders/999999999999').set(auth(customerA.token));
      assert.strictEqual(ghost.status, 404);
      assert.strictEqual(ghost.body.error.code, 'ORDER_NOT_FOUND');
      // SQLi-shaped ids are just invalid ids — parameterization means nothing runs.
      const inj = await request(app)
        .get(`/api/orders/${encodeURIComponent('1; DROP TABLE orders;--')}`)
        .set(auth(customerA.token));
      assert.strictEqual(inj.status, 400);
      const still = await db.query('SELECT count(*)::int AS n FROM orders');
      assert.ok(still.rows[0].n >= 0, 'orders table vanished?!');
    });

    // ── Missing authentication matrix ─────────────────────────────────────────
    test('anonymous requests to protected endpoints → 401 UNAUTHENTICATED', async () => {
      const anon = [
        ['get', '/api/orders'],
        ['get', '/api/orders/1'],
        ['post', '/api/orders'],
        ['patch', '/api/orders/1/status'],
        ['post', '/api/orders/1/cancel'],
        ['get', '/api/cart'],
        ['post', '/api/cart/items'],
        ['get', '/api/invoices'],
        ['get', '/api/audit-logs'],
        ['get', '/api/users'],
        ['get', '/api/inventory'],
        ['patch', '/api/inventory/1'],
        ['post', '/api/products'],
        ['get', '/api/reports/dashboard'],
      ];
      for (const [method, url] of anon) {
        const res = await request(app)[method](url);
        assert.strictEqual(res.status, 401, `${method.toUpperCase()} ${url} → ${res.status}`);
        assert.strictEqual(res.body.error.code, 'UNAUTHENTICATED');
      }
    });

    test('garbage bearer tokens → 401, never 500', async () => {
      for (const tok of ['not.a.jwt', 'a.b.c', 'Bearer'.repeat(3)]) {
        const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${tok}`);
        assert.strictEqual(res.status, 401, `token '${tok}' → ${res.status}`);
      }
      // A well-formed JWT signed with the WRONG secret must be rejected too
      // (alg/iss/aud/typ pinned in token.service — this is the forged-token probe).
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign(
        { sub: String(customerA.id), role: 'admin', typ: 'access' },
        'attacker-guessed-secret-0123456789',
        { algorithm: 'HS256' }
      );
      const f = await request(app).get('/api/orders').set('Authorization', `Bearer ${forged}`);
      assert.strictEqual(f.status, 401);
      // "alg: none" style downgrade must also fail.
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${
        jwt.decode(forged)
          ? Buffer.from(JSON.stringify(jwt.decode(forged))).toString('base64url')
          : ''
      }.`;
      const n = await request(app).get('/api/orders').set('Authorization', `Bearer ${none}`);
      assert.strictEqual(n.status, 401);
    });

    // ── Insufficient permissions (RBAC matrix) ────────────────────────────────
    test('role gates: customer/agent/admin each see exactly their API surface', async () => {
      // Customer must NOT reach admin/staff surfaces.
      const custForbidden = [
        ['get', '/api/audit-logs', undefined],
        ['get', '/api/users', undefined],
        ['post', '/api/products', { sku: SKU(), name: 'x', unit_price: '1.00', tax_rate: '0' }],
        ['patch', '/api/inventory/1', { delta: 1, reason: 'nope' }],
        ['get', '/api/inventory', undefined],
        ['get', '/api/reports/dashboard', undefined],
        ['post', '/api/invoices/1/void', { reason: 'customer should not void' }],
      ];
      for (const [method, url, body] of custForbidden) {
        let req = request(app)[method](url).set(auth(customerA.token));
        if (body !== undefined) req = req.send(body);
        const res = await req;
        assert.strictEqual(
          res.status,
          403,
          `customer ${method.toUpperCase()} ${url} → ${res.status}`
        );
        assert.strictEqual(res.body.error.code, 'FORBIDDEN');
      }
      // ORDER_MANAGER (agent) may NOT see the audit trail or manage users/products.
      for (const url of ['/api/audit-logs', '/api/users', '/api/reports/dashboard']) {
        const res = await request(app).get(url).set(auth(agent.token));
        assert.strictEqual(res.status, 403, `agent GET ${url} → ${res.status}`);
      }
      const agentAdjust = await request(app)
        .patch('/api/inventory/1')
        .set(auth(agent.token))
        .send({ delta: 1, reason: 'agent should not adjust' });
      assert.strictEqual(agentAdjust.status, 403);
      // Only customers create orders; admin/agent are 403 there.
      for (const u of [admin, agent]) {
        const res = await place(u.token, {}, KEY());
        assert.strictEqual(res.status, 403, `${u.email} order create → ${res.status}`);
      }
    });

    // ── Mass assignment ───────────────────────────────────────────────────────
    test('extra/mutable fields (role, price, status, customer_id) are rejected, not ignored-into-DB', async () => {
      const reg = await request(app)
        .post('/api/auth/register')
        .set('X-Test-Bucket', nextBucket())
        .send({
          name: 'Mallory Admin',
          email: `mallory-${U()}@security.test`,
          password: 'Str0ngPass!',
          role: 'admin',
        });
      assert.strictEqual(reg.status, 400, JSON.stringify(reg.body));
      assert.strictEqual(reg.body.error.code, 'VALIDATION_ERROR');

      const p = await createProduct(admin, { name: `MassAssign${U()}`, initial_stock: 5 });
      const ord = await place(
        customerA.token,
        {
          items: [{ product_id: p.id, quantity: 1, unit_price: '0.01' }],
        },
        KEY()
      );
      assert.strictEqual(ord.status, 400, JSON.stringify(ord.body)); // client prices never accepted
      assert.strictEqual(ord.body.error.code, 'VALIDATION_ERROR');

      const byBody = await place(
        customerA.token,
        {
          items: [{ product_id: p.id, quantity: 1 }],
          customer_id: Number(customerB.id),
          status: 'delivered',
        },
        KEY()
      );
      assert.strictEqual(byBody.status, 400); // unknown/forbidden fields → strict rejection
      const stillPending = await place(
        customerA.token,
        {
          items: [{ product_id: p.id, quantity: 1, status: 'shipped' }],
        },
        KEY()
      );
      assert.strictEqual(stillPending.status, 400);
    });

    // ── Cross-customer IDOR: orders, invoices, cart ───────────────────────────
    test('customer B cannot read or mutate anything owned by customer A (404, no existence leak)', async () => {
      const p = await createProduct(admin, { name: `IDOR${U()}`, initial_stock: 10 });
      const aOrd = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 2 }] },
        KEY()
      );
      assert.strictEqual(aOrd.status, 201, JSON.stringify(aOrd.body));
      const orderId = aOrd.body.id;

      // A ships it (staff-driven) so an invoice exists for the read attempts.
      await advanceTo(agent.token, orderId, 'processing');
      const ship = await patchStatus(agent.token, orderId, 'shipped');
      assert.strictEqual(ship.status, 200);
      const invRow = (await db.query('SELECT id FROM invoices WHERE order_id = $1', [orderId]))
        .rows[0];
      assert.ok(invRow, 'invoice should exist after ship');

      // Cart item of A (for B-vs-cart-line probes).
      const aCart = await request(app)
        .post('/api/cart/items')
        .set(auth(customerA.token))
        .send({ product_id: p.id, quantity: 1 });
      assert.strictEqual(aCart.status, 201, JSON.stringify(aCart.body));
      const aItemId = aCart.body.items[0].id;

      const probes = [
        ['get', `/api/orders/${orderId}`],
        ['get', `/api/orders/${orderId}/items`],
        ['get', `/api/orders/${orderId}/invoice`],
        ['get', `/api/invoices/${invRow.id}`],
        ['post', `/api/orders/${orderId}/cancel`],
        ['patch', `/api/cart/items/${aItemId}`],
        ['delete', `/api/cart/items/${aItemId}`],
      ];
      for (const [method, url] of probes) {
        let req = request(app)[method](url).set(auth(customerB.token));
        if (method === 'patch') req = req.send({ quantity: 1 });
        if (method === 'post' && url.includes('cancel')) req = req.send({ reason: 'idor probe' });
        if (method === 'post' && url.includes('void')) req = req.send({ reason: 'idor probe' });
        const res = await req;
        assert.strictEqual(
          res.status,
          404,
          `B ${method.toUpperCase()} ${url} → ${res.status} (expected 404)`
        );
      }

      // Listing scoping: B's order list never contains A's order, even when a
      // customer_id query param is forged (either rejected 400 or ignored).
      const list = await request(app)
        .get(`/api/orders?customer_id=${customerA.id}`)
        .set(auth(customerB.token));
      if (list.status === 200) {
        assert.ok(
          list.body.data.every((o) => o.customer_id === String(customerB.id)),
          'scoping leak'
        );
      } else {
        assert.strictEqual(list.status, 400);
      }
      // A's own cart is untouched by the foreign attempts.
      const aCartAfter = await request(app).get('/api/cart').set(auth(customerA.token));
      assert.strictEqual(aCartAfter.body.items.length, 1, 'A cart mutated by B');
    });

    // ── Unsafe status transitions ─────────────────────────────────────────────
    test('illegal transitions rejected with 409; cancel is a separate operation', async () => {
      const p = await createProduct(admin, { name: `Transitions${U()}`, initial_stock: 10 });
      const ord = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 1 }] },
        KEY()
      );
      const id = ord.body.id;

      for (const target of ['processing', 'shipped', 'delivered']) {
        const res = await patchStatus(agent.token, id, target);
        assert.strictEqual(res.status, 409, `pending → ${target} must be illegal`);
        assert.strictEqual(res.body.error.code, 'INVALID_STATE_TRANSITION');
      }
      const cancelAsStatus = await patchStatus(agent.token, id, 'cancelled');
      assert.strictEqual(cancelAsStatus.status, 409);
      assert.match(cancelAsStatus.body.error.message, /separate operation/);
      const bogus = await patchStatus(agent.token, id, 'destroyed');
      assert.strictEqual(bogus.status, 400); // fails schema, not state machine

      // Legal path forward, then terminal-state guards.
      await advanceTo(agent.token, id, 'shipped');
      const lateCancel = await cancel(customerA.token, id);
      assert.strictEqual(lateCancel.status, 409, 'cannot cancel a shipped order');
      await patchStatus(agent.token, id, 'delivered');
      // 'pending' is not even an accepted PATCH target (schema 400); every other
      // lifecycle value out of a terminal state must be a state-machine 409.
      for (const target of ['shipped', 'processing']) {
        const res = await patchStatus(agent.token, id, target);
        assert.strictEqual(res.status, 409, `delivered → ${target} must be illegal`);
      }
    });

    // ── Insufficient stock + rollback atomicity ───────────────────────────────
    test('over-request → 409 INSUFFICIENT_STOCK with zero side effects', async () => {
      const p = await createProduct(admin, { name: `ShortStock${U()}`, initial_stock: 2 });
      const before = await stockRow(p.id);
      const res = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 3 }] },
        KEY()
      );
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'INSUFFICIENT_STOCK');
      const after = await stockRow(p.id);
      assert.deepStrictEqual(after, before, 'stock changed on failed order');
      const n = (
        await db.query('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [
          customerA.id,
        ])
      ).rows[0].n;
      void n; // counted across the suite; the definitive no-partial-write check is below.
    });

    test('multi-line order with one unknown product rolls back completely (no orphan order/stock)', async () => {
      const p = await createProduct(admin, { name: `Rollback${U()}`, initial_stock: 5 });
      const before = await stockRow(p.id);
      const beforeOrders = (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
      const res = await place(
        customerA.token,
        {
          items: [
            { product_id: p.id, quantity: 1 },
            { product_id: 999999999999, quantity: 1 },
          ],
        },
        KEY()
      );
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      const after = await stockRow(p.id);
      assert.deepStrictEqual(after, before, 'reserved stock changed despite rollback');
      const afterOrders = (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
      assert.strictEqual(afterOrders, beforeOrders, 'partial order row survived rollback');
      const mv = (
        await db.query(
          "SELECT count(*)::int AS n FROM inventory_movements WHERE order_id IS NOT NULL AND product_id = $1 AND created_at > now() - interval '10 seconds'",
          [p.id]
        )
      ).rows[0].n;
      assert.strictEqual(mv, 0, 'reservation movement survived rollback');
    });

    // ── Concurrent ordering (oversell prevention) ─────────────────────────────
    test('parallel orders against limited stock never oversell (exactly one wins)', async () => {
      const p = await createProduct(admin, { name: `Oversell${U()}`, initial_stock: 5 });
      const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
          place(customerA.token, { items: [{ product_id: p.id, quantity: 3 }] }, KEY())
        )
      );
      const created = attempts.filter((r) => r.status === 201);
      const rejected = attempts.filter((r) => r.status === 409);
      assert.strictEqual(created.length, 1, `expected 1 success, got ${created.length}`);
      assert.strictEqual(rejected.length, 4, 'all losers must be 409 INSUFFICIENT_STOCK');
      for (const r of rejected) assert.strictEqual(r.body.error.code, 'INSUFFICIENT_STOCK');
      const row = await stockRow(p.id);
      assert.strictEqual(row.physical_quantity, 5, 'physical must be untouched');
      assert.strictEqual(row.reserved_quantity, 3);
      assert.strictEqual(row.available_quantity, 2);
    });

    // ── Duplicate submission (idempotency) ────────────────────────────────────
    test('same Idempotency-Key replays the stored response; different body conflicts', async () => {
      const p = await createProduct(admin, { name: `DupSubmit${U()}`, initial_stock: 10 });
      const key = KEY();
      const body = { items: [{ product_id: p.id, quantity: 2 }] };
      const first = await place(customerA.token, body, key);
      assert.strictEqual(first.status, 201);
      const replay = await place(customerA.token, body, key);
      // Convention (order.controller): a completed claim replays the ORIGINAL
      // body with 200 + idempotent marker — no second order is created.
      assert.strictEqual(replay.status, 200, 'replay must return the stored response');
      assert.strictEqual(replay.body.idempotent, true);
      assert.strictEqual(replay.body.id, first.body.id, 'replay created a different order');
      const conflict = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 5 }] },
        key
      );
      assert.strictEqual(conflict.status, 409);
      assert.strictEqual(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
      const row = await stockRow(p.id);
      assert.strictEqual(row.reserved_quantity, 2, 'replay/conflict must not reserve again');
    });

    // ── SAME-ORDER TRANSITION RACE (Phase 11 fix: FOR UPDATE on the orders row) ─
    test('concurrent duplicate ship consumes stock exactly once and mints one invoice', async () => {
      const p = await createProduct(admin, { name: `ShipRace${U()}`, initial_stock: 6 });
      // Two separate orders so a double-consume by one order would silently eat
      // the OTHER order's intact reservation when the row is not locked.
      const o1 = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 2 }] },
        KEY()
      );
      const o2 = await place(
        customerB.token,
        { items: [{ product_id: p.id, quantity: 2 }] },
        KEY()
      );
      assert.strictEqual(o1.status, 201);
      assert.strictEqual(o2.status, 201);
      await advanceTo(agent.token, o1.body.id, 'processing');

      const ships = await Promise.all([
        patchStatus(agent.token, o1.body.id, 'shipped'),
        patchStatus(agent.token, o1.body.id, 'shipped'),
      ]);
      const codes = ships.map((r) => r.status).sort();
      assert.deepStrictEqual(
        codes,
        [200, 409],
        `expected one ship + one 409, got ${codes.join(',')}`
      );
      const loser = ships.find((r) => r.status === 409);
      assert.strictEqual(loser.body.error.code, 'INVALID_STATE_TRANSITION');

      const row = await stockRow(p.id);
      assert.strictEqual(row.physical_quantity, 4, 'stock consumed more than once');
      assert.strictEqual(row.reserved_quantity, 2, "order 2's reservation must stay intact");
      const inv = (
        await db.query('SELECT count(*)::int AS n FROM invoices WHERE order_id = $1', [o1.body.id])
      ).rows[0].n;
      assert.strictEqual(inv, 1, 'duplicate invoice minted');
      assert.strictEqual(
        await auditCount('STOCK_CONSUMED', o1.body.id),
        1,
        'duplicate consumption audit'
      );
      // Exactly ONE event reached 'shipped' (the earlier confirm/process steps
      // are separate ORDER_STATUS_CHANGED events and are not part of the race).
      const shippedAudits = (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ORDER_STATUS_CHANGED' AND entity_id = $1 AND details->>'to' = 'shipped'",
          [o1.body.id]
        )
      ).rows[0].n;
      assert.strictEqual(shippedAudits, 1, 'duplicate ship audit');
    });

    test('concurrent duplicate cancel releases stock exactly once', async () => {
      const p = await createProduct(admin, { name: `CancelRace${U()}`, initial_stock: 6 });
      const o = await place(customerA.token, { items: [{ product_id: p.id, quantity: 2 }] }, KEY());
      const conf = await patchStatus(agent.token, o.body.id, 'confirmed');
      assert.strictEqual(conf.status, 200);

      const cancels = await Promise.all([
        cancel(customerA.token, o.body.id, 'race one'),
        cancel(customerA.token, o.body.id, 'race two'),
      ]);
      const codes = cancels.map((r) => r.status).sort();
      assert.deepStrictEqual(
        codes,
        [200, 409],
        `expected one cancel + one 409, got ${codes.join(',')}`
      );

      const row = await stockRow(p.id);
      assert.strictEqual(row.reserved_quantity, 0, 'reservation released twice');
      assert.strictEqual(row.physical_quantity, 6);
      const rel = (
        await db.query(
          "SELECT count(*)::int AS n FROM inventory_movements WHERE order_id = $1 AND movement_type = 'cancellation_release'",
          [o.body.id]
        )
      ).rows[0].n;
      assert.strictEqual(rel, 1, 'duplicate cancellation_release movement');
    });

    // ── Rate limiting on registration (login 429 covered in auth-http suite) ──
    test('registration is rate limited in an enforced bucket (429 RATE_LIMITED)', async (t) => {
      if (process.env.B2B_ENFORCE_RATE_LIMIT !== '1') {
        t.skip('runner does not enforce rate limits');
        return;
      }
      const bucket = `sec-reg-${U()}`; // dedicated bucket, never reused
      let limited = null;
      for (let i = 0; i < config.registerRateMax + 2; i++) {
        const res = await request(app)
          .post('/api/auth/register')
          .set('X-Test-Bucket', bucket)
          .send({
            name: `Reg ${i}`,
            email: `reg${i}-${U()}@security.test`,
            password: 'Str0ngPass!',
          });
        if (res.status === 429) {
          limited = res;
          break;
        }
      }
      assert.ok(limited, `429 never arrived within ${config.registerRateMax + 2} attempts`);
      assert.strictEqual(limited.body.error.code, 'RATE_LIMITED');
    });

    // ── DB-level last-line defenses (missing-constraint verification) ─────────
    test('CHECK constraints make an application-level oversell physically impossible', async () => {
      const p = await createProduct(admin, { name: `CheckGuard${U()}`, initial_stock: 4 });
      const ord = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 4 }] },
        KEY()
      );
      assert.strictEqual(ord.status, 201);
      // Try to force the DB into an oversold state directly (simulating a buggy
      // code path): physical < reserved must be rejected by the CHECK.
      await assert.rejects(
        () => db.query('UPDATE inventory SET physical_quantity = 1 WHERE product_id = $1', [p.id]),
        (err) => {
          assert.strictEqual(err.code, '23514');
          return true;
        }
      );
      // And a negative reservation likewise.
      await assert.rejects(
        () => db.query('UPDATE inventory SET reserved_quantity = -1 WHERE product_id = $1', [p.id]),
        (err) => err.code === '23514'
      );
    });

    test('audit trail is append-only at the DATABASE level', async () => {
      const { rows } = await db.query('SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1');
      assert.ok(rows.length, 'expected at least one audit row to attempt to tamper with');
      await assert.rejects(
        () => db.query(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = $1`, [rows[0].id]),
        /append-only/
      );
      await assert.rejects(
        () => db.query('DELETE FROM audit_logs WHERE id = $1', [rows[0].id]),
        /append-only/
      );
    });

    test('illegal order status values cannot be written even via direct SQL', async () => {
      const p = await createProduct(admin, { name: `StatusCheck${U()}`, initial_stock: 1 });
      const ord = await place(
        customerA.token,
        { items: [{ product_id: p.id, quantity: 1 }] },
        KEY()
      );
      await assert.rejects(
        () => db.query('UPDATE orders SET status = $2 WHERE id = $1', [ord.body.id, 'garbage']),
        (err) => err.code === '23514'
      );
    });

    // ── Error-envelope consistency ────────────────────────────────────────────
    test('every failure uses the single { error: { code, message } } envelope', async () => {
      const samples = await Promise.all([
        request(app).get('/api/nope'), // 404 route-not-found
        request(app).get('/api/orders').set(auth(customerA.token)), // 200 (control)
        request(app).post('/api/orders').set(auth(customerB.token)).send({ items: [] }), // 400/422
      ]);
      for (const res of samples) {
        if (res.status >= 400) {
          assert.ok(
            res.body.error && res.body.error.code && res.body.error.message,
            `envelope missing for ${res.status}: ${JSON.stringify(res.body)}`
          );
          assert.ok(!res.body.stack && !res.body.trace, 'stack in error body');
        }
      }
    });
  }
);
