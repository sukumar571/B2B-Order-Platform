'use strict';

/**
 * Phase 7 — order management + inventory transaction integration tests.
 * Runs ONLY against the isolated DATABASE_URL_TEST database and ONLY via
 * `npm run test:integration` (B2B_RUN_DB_TESTS=1). Plain `npm test` skips it.
 *
 * Exercises the real Express + PostgreSQL path for the Must-level order
 * acceptance criteria: server-priced creation (AC-ORD-01/03), atomic rollback
 * with no stock change (AC-ORD-02), idempotent replay + request matching
 * (AC-ORD-04/07), oversell prevention under concurrency (AC-ORD-05), snapshot
 * immutability (AC-ORD-06), the enforced state machine, single-release
 * cancellation vs single-consumption shipment, and per-role ownership
 * (AC-LIF-05 / FR-ORD-11).
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
  const email = `${role}-${U()}@order.test`;
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

const addToCart = (token, body) =>
  request(app).post('/api/cart/items').set('Authorization', `Bearer ${token}`).send(body);

function place(token, body, key) {
  let req = request(app).post('/api/orders').set('Authorization', `Bearer ${token}`);
  if (key !== undefined) req = req.set('Idempotency-Key', key);
  return req.send(body || {});
}

async function stock(productId) {
  const r = await db.query(
    'SELECT physical_quantity, reserved_quantity, available_quantity FROM inventory WHERE product_id = $1',
    [productId]
  );
  return r.rows[0];
}

const orderCount = async (customerId) =>
  (await db.query('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [customerId]))
    .rows[0].n;

describe('Orders over HTTP (isolated test DB)', { skip: SKIP_REASON, timeout: 240000 }, () => {
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
  test('order creation is customer-only (anon 401, admin/agent 403)', async () => {
    assert.strictEqual((await place(undefined, {}, KEY())).status, 401);
    assert.strictEqual((await place(admin.token, {}, KEY())).status, 403);
    assert.strictEqual((await place(agent.token, {}, KEY())).status, 403);
    // A customer may not read staff listings unauthenticated.
    assert.strictEqual((await request(app).get('/api/orders')).status, 401);
  });

  // ── Idempotency header contract (AC-ORD-07) ───────────────────────────────
  test('missing Idempotency-Key → 400; malformed key → 400', async () => {
    const p = await createProduct(admin, { name: `NoKey${U()}`, initial_stock: 5 });
    const noKey = await place(customer.token, { items: [{ product_id: p.id, quantity: 1 }] });
    assert.strictEqual(noKey.status, 400);
    assert.strictEqual(noKey.body.error.code, 'MISSING_IDEMPOTENCY_KEY');

    const badKey = await place(
      customer.token,
      { items: [{ product_id: p.id, quantity: 1 }] },
      'not-a-uuid'
    );
    assert.strictEqual(badKey.status, 400);
    assert.strictEqual(badKey.body.error.code, 'VALIDATION_ERROR');
  });

  // ── Successful order from the cart (AC-ORD-01 / AC-ORD-03) ──────────────────
  test('POST /api/orders places a cart order, reserves stock, empties the cart, audits', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Ord${U()}`,
      unit_price: '19.99',
      tax_rate: '7.5',
      initial_stock: 10,
    });
    await addToCart(c.token, { product_id: p.id, quantity: 2 });

    const res = await place(c.token, {}, KEY());
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const order = res.body;
    assert.strictEqual(order.status, 'pending');
    assert.strictEqual(order.customer_id, String(c.id));
    assert.strictEqual(order.items.length, 1);
    // Server-derived money: 19.99 × 2 @ 7.5% → 39.98 / 3.00 (half-up) / 42.98.
    assert.strictEqual(order.items[0].line_total, '39.98');
    assert.strictEqual(order.subtotal, '39.98');
    assert.strictEqual(order.tax_total, '3.00');
    assert.strictEqual(order.grand_total, '42.98');
    // Snapshot name/price stored on the item.
    assert.strictEqual(order.items[0].product_name, p.name);

    // Reservation: physical untouched, reserved +2, available -2.
    const s = await stock(p.id);
    assert.strictEqual(Number(s.physical_quantity), 10);
    assert.strictEqual(Number(s.reserved_quantity), 2);
    assert.strictEqual(Number(s.available_quantity), 8);

    // Cart emptied automatically (FR-CART-05).
    const cart = await request(app).get('/api/cart').set('Authorization', `Bearer ${c.token}`);
    assert.deepStrictEqual(cart.body.items, []);

    const audit = await db.query(
      `SELECT action, actor_role FROM audit_logs WHERE entity_type='order' AND entity_id=$1`,
      [order.id]
    );
    assert.ok(audit.rows.some((r) => r.action === 'ORDER_CREATED' && r.actor_role === 'customer'));
  });

  // ── Client price is never trusted (AC-ORD-03) ───────────────────────────────
  test('a client-sent price in the body is rejected (strict → 400), stock untouched', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Ig${U()}`,
      unit_price: '10.00',
      initial_stock: 5,
    });
    const res = await place(
      c.token,
      { items: [{ product_id: p.id, quantity: 1, unit_price: '0.01' }] },
      KEY()
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
    assert.strictEqual((await stock(p.id)).reserved_quantity, 0);
  });

  // ── Invalid quantities (FR-ORD / validation) ────────────────────────────────
  test('invalid quantity and product_id are rejected with 400', async () => {
    const p = await createProduct(admin, { name: `Q${U()}`, initial_stock: 50 });
    for (const q of [0, -3, 1.5, 1001]) {
      const res = await place(
        customer.token,
        { items: [{ product_id: p.id, quantity: q }] },
        KEY()
      );
      assert.strictEqual(res.status, 400, `quantity ${q} must be rejected`);
    }
    assert.strictEqual(
      (await place(customer.token, { items: [{ product_id: 0, quantity: 1 }] }, KEY())).status,
      400
    );
  });

  // ── Empty cart (AC-ORD-08) ──────────────────────────────────────────────────
  test('ordering with an empty cart returns 422 EMPTY_CART', async () => {
    const c = await makeUser('customer');
    const res = await place(c.token, {}, KEY());
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error.code, 'EMPTY_CART');
  });

  // ── Inactive product cannot be ordered (FR-CAT-08) ──────────────────────────
  test('ordering an inactive product returns 404 and creates no order', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Off${U()}`,
      is_active: false,
      initial_stock: 5,
    });
    const res = await place(c.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY());
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.code, 'PRODUCT_NOT_FOUND');
    assert.strictEqual(await orderCount(c.id), 0);
  });

  // ── Insufficient stock ⇒ full rollback (AC-ORD-02) ──────────────────────────
  test('a shortfall line aborts the whole order with 409 and changes no stock', async () => {
    const c = await makeUser('customer');
    const ok = await createProduct(admin, { name: `Ok${U()}`, initial_stock: 100 });
    const short = await createProduct(admin, { name: `Short${U()}`, initial_stock: 2 });
    const res = await place(
      c.token,
      {
        items: [
          { product_id: ok.id, quantity: 5 },
          { product_id: short.id, quantity: 5 },
        ],
      },
      KEY()
    );
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error.code, 'INSUFFICIENT_STOCK');
    // Offenders are named (FR-ORD-03).
    assert.ok(
      res.body.error.details.items.some(
        (i) => i.product_id === String(short.id) && i.available === 2
      )
    );
    // Atomicity: NO order row, and NEITHER product's stock changed.
    assert.strictEqual(await orderCount(c.id), 0);
    assert.strictEqual((await stock(ok.id)).reserved_quantity, 0);
    assert.strictEqual((await stock(short.id)).reserved_quantity, 0);
  });

  // ── Idempotent replay + request matching (AC-ORD-04) ────────────────────────
  test('the same key replays one order; a different body under the same key → 409', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Idem${U()}`,
      unit_price: '5.00',
      initial_stock: 50,
    });
    const key = KEY();
    const body = { items: [{ product_id: p.id, quantity: 2 }] };

    const first = await place(c.token, body, key);
    assert.strictEqual(first.status, 201);
    const second = await place(c.token, body, key);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.idempotent, true);
    assert.strictEqual(second.body.id, first.body.id, 'same order replayed');
    assert.strictEqual(await orderCount(c.id), 1, 'exactly one order');
    // Stock reserved exactly once (2, not 4).
    assert.strictEqual((await stock(p.id)).reserved_quantity, 2);

    // Same key, different request → conflict, no new order.
    const conflict = await place(c.token, { items: [{ product_id: p.id, quantity: 9 }] }, key);
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.strictEqual(await orderCount(c.id), 1);
  });

  test('staggered parallel double-submit with one key creates a single order', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Par${U()}`,
      unit_price: '4.00',
      initial_stock: 30,
    });
    const key = KEY();
    const body = { items: [{ product_id: p.id, quantity: 3 }] };
    const [a, b] = await Promise.all([
      place(c.token, body, key),
      new Promise((resolve) => setTimeout(() => resolve(place(c.token, body, key)), 150)),
    ]);
    // The first claim always wins (201). The retry is either a verbatim replay
    // (200) once the winner committed, or a 409 DUPLICATE_REQUEST if it arrives
    // while the winner is still in flight — both are correct: NEITHER creates a
    // second order nor double-reserves stock (AC-ORD-04 / risk R-04).
    assert.strictEqual(a.status, 201);
    assert.ok([200, 409].includes(b.status), `unexpected second status ${b.status}`);
    assert.strictEqual(await orderCount(c.id), 1, 'exactly one order for the shared key');
    assert.strictEqual((await stock(p.id)).reserved_quantity, 3, 'stock reserved once');
  });

  // ── Oversell prevention under real concurrency (AC-ORD-05) ──────────────────
  test('20 concurrent buyers for 5 units: 5 succeed, 15 get 409, stock never negative', async () => {
    const p = await createProduct(admin, {
      name: `Flash${U()}`,
      unit_price: '2.00',
      initial_stock: 5,
    });
    const buyers = await Promise.all(Array.from({ length: 20 }, () => makeUser('customer')));

    const results = await Promise.all(
      buyers.map((b) => place(b.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY()))
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter(
      (r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK'
    ).length;

    assert.strictEqual(created, 5, 'exactly stock-many orders succeed');
    assert.strictEqual(rejected, 15, 'the rest are refused');
    const s = await stock(p.id);
    assert.strictEqual(Number(s.physical_quantity), 5);
    assert.strictEqual(Number(s.reserved_quantity), 5);
    assert.strictEqual(Number(s.available_quantity), 0, 'never oversold / negative');
  });

  // ── State machine + ship consumes stock exactly once (FR-ORD-07/09/10) ───────
  test('legal chain pending→confirmed→processing→shipped→delivered consumes at ship', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Chain${U()}`,
      unit_price: '3.00',
      initial_stock: 100,
    });
    const created = await place(c.token, { items: [{ product_id: p.id, quantity: 4 }] }, KEY());
    const id = created.body.id;
    const patch = (status) =>
      request(app)
        .patch(`/api/orders/${id}/status`)
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ status });

    for (const status of ['confirmed', 'processing']) {
      const r = await patch(status);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.status, status);
    }
    // Before shipment the reservation is held, physical untouched.
    assert.strictEqual((await stock(p.id)).reserved_quantity, 4);

    const shipped = await patch('shipped');
    assert.strictEqual(shipped.status, 200);
    // Consumption: physical -4 AND reserved -4; available unchanged (96).
    const s = await stock(p.id);
    assert.strictEqual(Number(s.physical_quantity), 96);
    assert.strictEqual(Number(s.reserved_quantity), 0);
    assert.strictEqual(Number(s.available_quantity), 96);

    const delivered = await patch('delivered');
    assert.strictEqual(delivered.status, 200);
    assert.strictEqual(
      Number((await stock(p.id)).physical_quantity),
      96,
      'delivered does not re-deduct'
    );
  });

  test('invalid transitions are rejected with 409; terminal states have no edges', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, { name: `Bad${U()}`, initial_stock: 20 });
    const id = (await place(c.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY())).body
      .id;

    // pending → shipped (skips two states) → 409.
    const skip = await request(app)
      .patch(`/api/orders/${id}/status`)
      .set('Authorization', `Bearer ${agent.token}`)
      .send({ status: 'shipped' });
    assert.strictEqual(skip.status, 409);
    assert.strictEqual(skip.body.error.code, 'INVALID_STATE_TRANSITION');

    // Move to confirmed. 'pending' is the initial state and is never a legal
    // PATCH target, so it fails closed at the schema layer (400) — the request
    // never reaches the state machine.
    await request(app)
      .patch(`/api/orders/${id}/status`)
      .set('Authorization', `Bearer ${agent.token}`)
      .send({ status: 'confirmed' });
    const notTargetable = await request(app)
      .patch(`/api/orders/${id}/status`)
      .set('Authorization', `Bearer ${agent.token}`)
      .send({ status: 'pending' });
    assert.strictEqual(notTargetable.status, 400);
    // A schema-valid target that is state-illegal (confirmed → shipped skips
    // processing) is refused by the transition matrix with 409.
    const skipForward = await request(app)
      .patch(`/api/orders/${id}/status`)
      .set('Authorization', `Bearer ${agent.token}`)
      .send({ status: 'shipped' });
    assert.strictEqual(skipForward.status, 409);
    assert.strictEqual(skipForward.body.error.code, 'INVALID_STATE_TRANSITION');
  });

  test('customers cannot update administrative order statuses', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, { name: `Role${U()}`, initial_stock: 20 });
    const id = (await place(c.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY())).body
      .id;
    const res = await request(app)
      .patch(`/api/orders/${id}/status`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ status: 'confirmed' });
    assert.strictEqual(res.status, 403);
  });

  // ── Cancellation releases the reservation exactly once (FR-ORD-08) ──────────
  test('cancel releases the reservation once; re-cancel and post-ship cancel are refused', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Can${U()}`,
      unit_price: '6.00',
      initial_stock: 10,
    });
    const id = (await place(c.token, { items: [{ product_id: p.id, quantity: 3 }] }, KEY())).body
      .id;
    assert.strictEqual((await stock(p.id)).reserved_quantity, 3);

    const cancel = await request(app)
      .post(`/api/orders/${id}/cancel`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ reason: 'no longer needed' });
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual(cancel.body.status, 'cancelled');
    const s = await stock(p.id);
    assert.strictEqual(Number(s.reserved_quantity), 0, 'reservation released');
    assert.strictEqual(Number(s.available_quantity), 10);

    // Cancelling a cancelled order → 409 (no second release).
    const again = await request(app)
      .post(`/api/orders/${id}/cancel`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ reason: 'again' });
    assert.strictEqual(again.status, 409);

    // A shipped order cannot be cancelled (stock already consumed).
    const p2 = await createProduct(admin, { name: `CanShip${U()}`, initial_stock: 10 });
    const id2 = (await place(c.token, { items: [{ product_id: p2.id, quantity: 1 }] }, KEY())).body
      .id;
    for (const status of ['confirmed', 'processing', 'shipped']) {
      await request(app)
        .patch(`/api/orders/${id2}/status`)
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ status });
    }
    const lateCancel = await request(app)
      .post(`/api/orders/${id2}/cancel`)
      .set('Authorization', `Bearer ${agent.token}`)
      .send({ reason: 'too late' });
    assert.strictEqual(lateCancel.status, 409);
  });

  // ── Ownership isolation (FR-ORD-11 / AC-LIF-05) ─────────────────────────────
  test('a customer cannot read or cancel another customer’s order (404, not 403)', async () => {
    const a = await makeUser('customer');
    const b = await makeUser('customer');
    const p = await createProduct(admin, { name: `Own${U()}`, initial_stock: 20 });
    const id = (await place(a.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY())).body
      .id;

    assert.strictEqual(
      (await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${b.token}`))
        .status,
      404
    );
    assert.strictEqual(
      (await request(app).get(`/api/orders/${id}/items`).set('Authorization', `Bearer ${b.token}`))
        .status,
      404
    );
    assert.strictEqual(
      (
        await request(app)
          .post(`/api/orders/${id}/cancel`)
          .set('Authorization', `Bearer ${b.token}`)
          .send({ reason: 'not mine' })
      ).status,
      404
    );
    // Staff can read it; the owner can too.
    assert.strictEqual(
      (await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${admin.token}`))
        .status,
      200
    );
  });

  test('customers list only their own orders; staff list all and can filter', async () => {
    const a = await makeUser('customer');
    const b = await makeUser('customer');
    const p = await createProduct(admin, { name: `List${U()}`, initial_stock: 50 });
    await place(a.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY());
    await place(a.token, { items: [{ product_id: p.id, quantity: 2 }] }, KEY());
    await place(b.token, { items: [{ product_id: p.id, quantity: 1 }] }, KEY());

    const aList = await request(app).get('/api/orders').set('Authorization', `Bearer ${a.token}`);
    assert.strictEqual(aList.status, 200);
    assert.strictEqual(aList.body.data.length, 2, 'only A’s two orders');
    assert.ok(aList.body.data.every((o) => o.customer_id === String(a.id)));

    const staff = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${admin.token}`);
    assert.ok(staff.body.data.length >= 3, 'staff sees all');

    const pending = await request(app)
      .get('/api/orders?status=pending')
      .set('Authorization', `Bearer ${admin.token}`);
    assert.ok(pending.body.data.every((o) => o.status === 'pending'));
  });

  // ── Snapshot immutability (AC-ORD-06) ───────────────────────────────────────
  test('order item snapshots are immune to later catalog price/name edits', async () => {
    const c = await makeUser('customer');
    const p = await createProduct(admin, {
      name: `Snap${U()}`,
      unit_price: '12.00',
      tax_rate: '0',
      initial_stock: 20,
    });
    const created = await place(c.token, { items: [{ product_id: p.id, quantity: 2 }] }, KEY());
    const id = created.body.id;
    const before = created.body.items[0];
    assert.strictEqual(before.unit_price, '12.00');
    assert.strictEqual(before.line_total, '24.00');

    await request(app)
      .patch(`/api/products/${p.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ unit_price: '999.00', name: 'Renamed Product' });

    const after = await request(app)
      .get(`/api/orders/${id}`)
      .set('Authorization', `Bearer ${c.token}`);
    assert.strictEqual(after.body.items[0].unit_price, '12.00', 'stored price unchanged');
    assert.strictEqual(after.body.items[0].line_total, '24.00');
    assert.strictEqual(after.body.items[0].product_name, p.name, 'stored name unchanged');
  });
});
