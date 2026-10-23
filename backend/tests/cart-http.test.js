'use strict';

/**
 * Phase 6 — shopping cart integration tests over real HTTP + PostgreSQL.
 * Runs ONLY against the isolated DATABASE_URL_TEST database and ONLY via
 * `npm run test:integration` (B2B_RUN_DB_TESTS=1). Plain `npm test` skips it.
 *
 * Covers the Must/Should cart acceptance criteria: ownership isolation
 * (AC-CART-05), upsert merge (AC-CART-01), server-derived exact totals
 * (AC-CART-02), quantity validation (AC-CART-04), stock warning WITHOUT
 * reservation (AC-CART-03), inactive-product rejection (FR-CAT-08), the
 * per-line maximum, cross-session persistence and audited cart mutations.
 */

process.env.NODE_ENV = 'test';

const path = require('node:path');
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

const app = createApp();

async function makeUser(role = 'customer') {
  const email = `${role}-${U()}@cart.test`;
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, '$2b$12$notarealhashnotarealhashnotarealhashnotareah', $2, $3)
     RETURNING id`,
    [email, `Test ${role}`, role]
  );
  const id = r.rows[0].id;
  const token = tokenService.signAccessToken({ userId: id, role });
  // A second, independently signed token stands in for a fresh login session.
  const relogin = () => tokenService.signAccessToken({ userId: id, role });
  return { id, email, token, relogin };
}

async function createProduct(admin, fields) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ sku: SKU(), name: 'Generic', unit_price: '10.00', tax_rate: '0', ...fields });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const add = (token, body) =>
  request(app).post('/api/cart/items').set('Authorization', `Bearer ${token}`).send(body);
const getCart = (token) => request(app).get('/api/cart').set('Authorization', `Bearer ${token}`);

describe(
  'Shopping cart over HTTP (isolated test DB)',
  { skip: SKIP_REASON, timeout: 180000 },
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

    // ── Access control: customer-only, self-scoped ───────────────────────────

    test('cart endpoints are customer-only (anon 401, admin/agent 403)', async () => {
      assert.strictEqual((await request(app).get('/api/cart')).status, 401);
      for (const t of [admin.token, agent.token]) {
        assert.strictEqual((await getCart(t)).status, 403);
        assert.strictEqual((await add(t, { product_id: 1, quantity: 1 })).status, 403);
      }
    });

    test('GET /api/cart starts empty with exact zero totals and no client-settable owner', async () => {
      const res = await getCart(customer.token);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.id, 'cart has an id');
      assert.deepStrictEqual(res.body.items, []);
      assert.deepStrictEqual(
        [res.body.subtotal, res.body.tax_total, res.body.grand_total],
        ['0.00', '0.00', '0.00']
      );
    });

    // ── Add + server-derived totals (AC-CART-02) ─────────────────────────────

    test('POST /api/cart/items adds a line and computes totals SERVER-SIDE', async () => {
      const p = await createProduct(admin, {
        name: `W${U()}`,
        unit_price: '19.99',
        tax_rate: '7.5',
        initial_stock: 100,
      });
      const res = await add(customer.token, { product_id: p.id, quantity: 3 });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.items.length, 1);
      const line = res.body.items[0];
      assert.strictEqual(line.product_id, p.id);
      assert.strictEqual(line.unit_price, '19.99', 'price comes from the catalog, not the client');
      assert.strictEqual(line.quantity, 3);
      assert.strictEqual(line.line_total, '59.97');
      assert.strictEqual(line.line_tax, '4.50', 'half-up per line (7.5%)');
      assert.strictEqual(res.body.subtotal, '59.97');
      assert.strictEqual(res.body.tax_total, '4.50');
      assert.strictEqual(res.body.grand_total, '64.47');
      // A client-supplied price/total must never be honored anywhere in the body.
      assert.ok(!JSON.stringify(res.body).includes('price_from_client'));
    });

    test('a client-sent unit_price / total in the body is ignored (strict → 400)', async () => {
      const p = await createProduct(admin, { name: `Ig${U()}`, unit_price: '5.00' });
      const res = await add(customer.token, {
        product_id: p.id,
        quantity: 1,
        unit_price: '0.01',
        grand_total: '0.00',
      });
      assert.strictEqual(res.status, 400, 'unknown fields are rejected outright');
      assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
    });

    // ── Upsert merge (AC-CART-01) ─────────────────────────────────────────────

    test('adding an existing product merges quantity instead of duplicating', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, {
        name: `M${U()}`,
        unit_price: '2.00',
        initial_stock: 50,
      });
      await add(c.token, { product_id: p.id, quantity: 2 });
      const res = await add(c.token, { product_id: p.id, quantity: 3 });
      assert.strictEqual(res.body.items.length, 1, 'still a single line');
      assert.strictEqual(res.body.items[0].quantity, 5, '2 + 3 merged');
      const rows = await db.query(
        `SELECT count(*)::int AS n FROM cart_items ci JOIN carts ca ON ca.id = ci.cart_id
        WHERE ca.customer_id = $1`,
        [c.id]
      );
      assert.strictEqual(rows.rows[0].n, 1, 'no duplicate DB row (UNIQUE cart_id,product_id)');
    });

    // ── Quantity validation (AC-CART-04) ──────────────────────────────────────

    test('quantity 0 / negative / fractional / > max is rejected with 400', async () => {
      const p = await createProduct(admin, { name: `Q${U()}`, initial_stock: 5000 });
      for (const q of [0, -1, 1.5, 1001]) {
        const res = await add(customer.token, { product_id: p.id, quantity: q });
        assert.strictEqual(res.status, 400, `quantity ${q} must be rejected`);
        assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
      }
    });

    test('invalid product_id and missing product_id are rejected with 400', async () => {
      assert.strictEqual((await add(customer.token, { product_id: 'abc' })).status, 400);
      assert.strictEqual((await add(customer.token, { product_id: 0 })).status, 400);
      assert.strictEqual((await add(customer.token, { quantity: 1 })).status, 400);
    });

    // ── Inactive product rejection (FR-CAT-08 / FR-CART-02) ────────────────────

    test('adding an inactive product returns 404 and creates no line', async () => {
      const p = await createProduct(admin, {
        name: `Off${U()}`,
        is_active: false,
        initial_stock: 10,
      });
      const res = await add(customer.token, { product_id: p.id, quantity: 1 });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'PRODUCT_NOT_FOUND');
      const cart = await getCart(customer.token);
      assert.ok(!cart.body.items.some((i) => i.product_id === p.id));
    });

    // ── Stock: reject over-availability, but never reserve (AC-CART-03) ────────

    test('adding more than available stock is refused 409 and reserves nothing', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, { name: `S${U()}`, initial_stock: 10 });
      const res = await add(c.token, { product_id: p.id, quantity: 11 });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'INSUFFICIENT_STOCK');
      const inv = await db.query('SELECT available_quantity FROM inventory WHERE product_id = $1', [
        p.id,
      ]);
      assert.strictEqual(
        Number(inv.rows[0].available_quantity),
        10,
        'cart did not decrement stock'
      );
    });

    test('stock_warning appears when on-hand falls below the cart quantity (no reservation)', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, {
        name: `Sw${U()}`,
        unit_price: '4.00',
        initial_stock: 20,
      });
      const added = await add(c.token, { product_id: p.id, quantity: 15 });
      assert.strictEqual(added.status, 201);
      assert.strictEqual(added.body.items[0].stock_warning, false);

      // Someone else buys/damages stock down to 5 (ADMIN adjustment) — cart held no reservation.
      const adj = await request(app)
        .patch(`/api/inventory/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ delta: -15, reason: 'sold elsewhere' });
      assert.strictEqual(adj.status, 200);

      const cart = await getCart(c.token);
      const line = cart.body.items[0];
      assert.strictEqual(line.quantity, 15, 'cart line unchanged by stock movement');
      assert.strictEqual(line.available_now, 5);
      assert.strictEqual(line.stock_warning, true, 'stale line is flagged, not silently dropped');
    });

    // ── Update / remove / clear ───────────────────────────────────────────────

    test('PATCH updates a line quantity; unknown id → 404', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, {
        name: `Up${U()}`,
        unit_price: '3.00',
        initial_stock: 30,
      });
      const added = await add(c.token, { product_id: p.id, quantity: 2 });
      const itemId = added.body.items[0].id;
      const res = await request(app)
        .patch(`/api/cart/items/${itemId}`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ quantity: 7 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.items[0].quantity, 7);
      assert.strictEqual(res.body.items[0].line_total, '21.00');
      assert.strictEqual(
        (
          await request(app)
            .patch('/api/cart/items/99999999')
            .set('Authorization', `Bearer ${c.token}`)
            .send({ quantity: 2 })
        ).status,
        404
      );
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/cart/items/${itemId}`)
            .set('Authorization', `Bearer ${c.token}`)
            .send({ quantity: 0 })
        ).status,
        400
      );
    });

    test('DELETE a line, then DELETE /api/cart empties it (204)', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, { name: `Del${U()}`, initial_stock: 40 });
      const added = await add(c.token, { product_id: p.id, quantity: 4 });
      const itemId = added.body.items[0].id;
      const removed = await request(app)
        .delete(`/api/cart/items/${itemId}`)
        .set('Authorization', `Bearer ${c.token}`);
      assert.strictEqual(removed.status, 200);
      assert.deepStrictEqual(removed.body.items, []);

      await add(c.token, { product_id: p.id, quantity: 2 });
      const cleared = await request(app)
        .delete('/api/cart')
        .set('Authorization', `Bearer ${c.token}`);
      assert.strictEqual(cleared.status, 204);
      assert.deepStrictEqual((await getCart(c.token)).body.items, []);
    });

    // ── Cross-user isolation (AC-CART-05) ─────────────────────────────────────

    test('customers cannot see or mutate another customer’s cart', async () => {
      const a = await makeUser('customer');
      const b = await makeUser('customer');
      const p = await createProduct(admin, { name: `Iso${U()}`, initial_stock: 20 });
      const added = await add(a.token, { product_id: p.id, quantity: 3 });
      const aItemId = added.body.items[0].id;

      // B sees an empty cart, never A’s line.
      assert.deepStrictEqual((await getCart(b.token)).body.items, []);
      // B cannot PATCH/DELETE A’s line — it is not in B’s cart → 404 (never 403).
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/cart/items/${aItemId}`)
            .set('Authorization', `Bearer ${b.token}`)
            .send({ quantity: 1 })
        ).status,
        404
      );
      assert.strictEqual(
        (
          await request(app)
            .delete(`/api/cart/items/${aItemId}`)
            .set('Authorization', `Bearer ${b.token}`)
        ).status,
        404
      );
      // A’s line is untouched.
      assert.strictEqual((await getCart(a.token)).body.items[0].quantity, 3);
    });

    // ── Persistence across sessions ───────────────────────────────────────────

    test('cart persists across sessions (a fresh token for the same user reloads it)', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, {
        name: `Pers${U()}`,
        unit_price: '6.00',
        initial_stock: 50,
      });
      await add(c.token, { product_id: p.id, quantity: 4 });

      // Simulate logout + login: brand-new token, same underlying user id.
      const cart2 = await getCart(c.relogin());
      assert.strictEqual(cart2.status, 200);
      assert.strictEqual(cart2.body.items.length, 1);
      assert.strictEqual(cart2.body.items[0].quantity, 4);
      assert.strictEqual(cart2.body.items[0].line_total, '24.00');
    });

    // ── Prices reflect the live catalog (not trusted from the client) ──────────

    test('totals recompute from the CURRENT catalog price at read time', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, {
        name: `Live${U()}`,
        unit_price: '10.00',
        initial_stock: 50,
      });
      const added = await add(c.token, { product_id: p.id, quantity: 2 });
      assert.strictEqual(added.body.items[0].line_total, '20.00');

      await request(app)
        .patch(`/api/products/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ unit_price: '12.50' });

      const cart = await getCart(c.token);
      assert.strictEqual(cart.body.items[0].unit_price, '12.50', 'cart shows the live price');
      assert.strictEqual(cart.body.items[0].line_total, '25.00');
    });

    // ── Audit trail ───────────────────────────────────────────────────────────

    test('cart mutations are audited with the actor role', async () => {
      const c = await makeUser('customer');
      const p = await createProduct(admin, { name: `Aud${U()}`, initial_stock: 20 });
      const added = await add(c.token, { product_id: p.id, quantity: 2 });
      const cartId = added.body.id;
      const audit = await db.query(
        `SELECT action, actor_role FROM audit_logs
        WHERE entity_type = 'cart' AND entity_id = $1 ORDER BY created_at`,
        [cartId]
      );
      assert.ok(audit.rows.some((r) => r.action === 'CART_ITEM_ADDED'));
      assert.ok(audit.rows.every((r) => r.actor_role === 'customer'));
      const body = JSON.stringify(added.body);
      assert.ok(!body.includes('$2b$'), 'no credential material leaked in the cart response');
    });
  }
);
