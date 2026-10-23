'use strict';

/**
 * Phase 5 — product catalog & inventory integration tests over real HTTP +
 * PostgreSQL. Runs ONLY against the isolated DATABASE_URL_TEST database and
 * ONLY via `npm run test:integration` (B2B_RUN_DB_TESTS=1). Plain `npm test`
 * skips this file (needs no database).
 *
 * Helpers create admin/agent/customer users DIRECTLY (rows + signed access
 * tokens) rather than through /api/auth/register, to stay independent of the
 * auth rate limiter. Authorization, uniqueness, transactional stock changes,
 * audit/movement writes and pagination/search/sort/filtering are all asserted.
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

/** Create a user row of a given role and return { id, email, token }. */
async function makeUser(role = 'customer') {
  const email = `${role}-${U()}@cat.test`;
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

/** Create a product through the ADMIN API; returns the product object. */
async function createProduct(admin, fields) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ sku: SKU(), name: 'Generic', unit_price: '10.00', ...fields });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

describe(
  'Catalog & inventory over HTTP (isolated test DB)',
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

    // ── Listing: auth, active filter, pagination, search, sort ──────────────

    test('GET /api/products is public and returns active products + meta', async () => {
      const tag = U();
      await createProduct(admin, { name: `ZZ ${tag} Alpha`, unit_price: '30.00' });
      await createProduct(admin, { name: `ZZ ${tag} Beta`, unit_price: '10.00' });
      await createProduct(admin, { name: `ZZ ${tag} Gamma`, unit_price: '20.00' });
      await createProduct(admin, { name: `ZZ ${tag} Gone`, unit_price: '5.00', is_active: false });

      // Anonymous browse → active only (Gone excluded).
      const res = await request(app)
        .get('/api/products')
        .query({ search: `ZZ ${tag}`, limit: 50 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.meta.total, 3, 'inactive product must be hidden');
      assert.ok(res.body.data.every((p) => p.is_active));
    });

    test('listing supports search, sorting by price, and pagination', async () => {
      const tag = U();
      await createProduct(admin, { name: `Q ${tag} A`, unit_price: '30.00' });
      await createProduct(admin, { name: `Q ${tag} B`, unit_price: '10.00' });
      await createProduct(admin, { name: `Q ${tag} C`, unit_price: '20.00' });

      const asc = await request(app)
        .get('/api/products')
        .query({ search: `Q ${tag}`, sort: 'price', order: 'asc', limit: 50 });
      assert.deepStrictEqual(
        asc.body.data.map((p) => p.unit_price),
        ['10.00', '20.00', '30.00']
      );

      const page1 = await request(app)
        .get('/api/products')
        .query({ search: `Q ${tag}`, sort: 'price', order: 'asc', page: 2, limit: 2 });
      assert.strictEqual(page1.body.data.length, 1);
      assert.strictEqual(page1.body.meta.total, 3);
      assert.strictEqual(page1.body.meta.page, 2);
      assert.strictEqual(page1.body.data[0].unit_price, '30.00');
    });

    test('listing rejects invalid query parameters with 400', async () => {
      assert.strictEqual(
        (await request(app).get('/api/products').query({ limit: '999' })).status,
        400
      );
      assert.strictEqual(
        (await request(app).get('/api/products').query({ sort: 'DROP TABLE' })).status,
        400
      );
      assert.strictEqual(
        (await request(app).get('/api/products').query({ page: 'abc' })).status,
        400
      );
      const bad = await request(app).get('/api/products').query({ limit: '999' });
      assert.strictEqual(bad.body.error.code, 'VALIDATION_ERROR');
    });

    // ── Detail: active visibility rule ──────────────────────────────────────

    test('GET /api/products/:id hides inactive from the public but not from admin', async () => {
      const p = await createProduct(admin, { name: `D ${U()}`, is_active: false });
      assert.strictEqual((await request(app).get(`/api/products/${p.id}`)).status, 404);
      const asAdmin = await request(app)
        .get(`/api/products/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`);
      assert.strictEqual(asAdmin.status, 200);
      assert.strictEqual(asAdmin.body.id, p.id);
      // Unknown id → 404; non-numeric id → 400.
      assert.strictEqual((await request(app).get('/api/products/99999999')).status, 404);
      assert.strictEqual((await request(app).get('/api/products/abc')).status, 400);
    });

    // ── Create: ADMIN only + rules ──────────────────────────────────────────

    test('POST /api/products: admin 201, unique SKU enforced, atomic inventory row', async () => {
      const sku = SKU();
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          sku,
          name: 'Fresh Widget',
          unit_price: '12.34',
          tax_rate: '5.5',
          initial_stock: 7,
        });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.sku, sku);
      assert.strictEqual(res.body.unit_price, '12.34');
      assert.strictEqual(res.body.available_stock, 7, 'inventory row created atomically');

      const dup = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ sku, name: 'Clash', unit_price: '1.00' });
      assert.strictEqual(dup.status, 409);
      assert.strictEqual(dup.body.error.code, 'DUPLICATE_SKU');
    });

    test('POST /api/products: invalid body 400 without creating a row', async () => {
      const before = (await db.query('SELECT count(*)::int AS n FROM products')).rows[0].n;
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ sku: SKU(), name: '', unit_price: '-5' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
      const afterCount = (await db.query('SELECT count(*)::int AS n FROM products')).rows[0].n;
      assert.strictEqual(afterCount, before, 'no partial write on validation failure');
    });

    test('POST /api/products: anonymous 401, customer/agent 403 (customers cannot modify)', async () => {
      const body = { sku: SKU(), name: 'Nope', unit_price: '1.00' };
      assert.strictEqual((await request(app).post('/api/products').send(body)).status, 401);
      const c = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${customer.token}`)
        .send(body);
      assert.strictEqual(c.status, 403);
      assert.strictEqual(c.body.error.code, 'FORBIDDEN');
      assert.strictEqual(
        (
          await request(app)
            .post('/api/products')
            .set('Authorization', `Bearer ${agent.token}`)
            .send(body)
        ).status,
        403
      );
    });

    // ── Update / deactivate: ADMIN only ─────────────────────────────────────

    test('PATCH /api/products/:id: admin edits + deactivates; others forbidden; 404/400 handled', async () => {
      const p = await createProduct(admin, { name: `U ${U()}`, unit_price: '9.00' });

      const edited = await request(app)
        .patch(`/api/products/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ unit_price: '11.11' });
      assert.strictEqual(edited.status, 200);
      assert.strictEqual(edited.body.unit_price, '11.11');

      const deactivated = await request(app)
        .patch(`/api/products/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ is_active: false });
      assert.strictEqual(deactivated.status, 200);
      assert.strictEqual(deactivated.body.is_active, false);
      // Inactive now hidden from the public catalog.
      const listed = await request(app).get('/api/products').query({ search: p.sku });
      assert.strictEqual(
        listed.body.meta.total,
        0,
        'deactivated product must drop out of the catalog'
      );

      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/products/${p.id}`)
            .set('Authorization', `Bearer ${customer.token}`)
            .send({ unit_price: '1.00' })
        ).status,
        403
      );
      assert.strictEqual(
        (await request(app).patch(`/api/products/${p.id}`).send({ unit_price: '1.00' })).status,
        401
      );
      assert.strictEqual(
        (
          await request(app)
            .patch('/api/products/99999999')
            .set('Authorization', `Bearer ${admin.token}`)
            .send({ unit_price: '1.00' })
        ).status,
        404
      );
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/products/${p.id}`)
            .set('Authorization', `Bearer ${admin.token}`)
            .send({})
        ).status,
        400
      );
    });

    test('PATCH /api/products/:id: SKU collision → 409', async () => {
      const a = await createProduct(admin, { name: 'A' });
      const b = await createProduct(admin, { name: 'B' });
      const res = await request(app)
        .patch(`/api/products/${b.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ sku: a.sku });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'DUPLICATE_SKU');
    });

    // ── Inventory visibility: staff only ────────────────────────────────────

    test('GET /api/inventory is staff-only (admin/agent 200, customer 403, anon 401)', async () => {
      assert.strictEqual((await request(app).get('/api/inventory')).status, 401);
      assert.strictEqual(
        (await request(app).get('/api/inventory').set('Authorization', `Bearer ${customer.token}`))
          .status,
        403
      );
      assert.strictEqual(
        (await request(app).get('/api/inventory').set('Authorization', `Bearer ${agent.token}`))
          .status,
        200
      );
      const adminRes = await request(app)
        .get('/api/inventory')
        .set('Authorization', `Bearer ${admin.token}`);
      assert.strictEqual(adminRes.status, 200);
      assert.ok(Array.isArray(adminRes.body.data));
    });

    test('GET /api/inventory/low-stock returns only available <= threshold', async () => {
      const low = await createProduct(admin, {
        name: `Low ${U()}`,
        initial_stock: 3,
        low_stock_threshold: 20,
      });
      const high = await createProduct(admin, {
        name: `High ${U()}`,
        initial_stock: 999,
        low_stock_threshold: 20,
      });

      const res = await request(app)
        .get('/api/inventory/low-stock')
        .set('Authorization', `Bearer ${agent.token}`)
        .query({ limit: 100 });
      assert.strictEqual(res.status, 200);
      const ids = res.body.data.map((i) => i.product_id);
      assert.ok(ids.includes(low.id), 'low-stock product present');
      assert.ok(!ids.includes(high.id), 'healthy product excluded');
      assert.ok(
        res.body.data.every((i) => i.is_low_stock && i.available_quantity <= i.low_stock_threshold)
      );
    });

    // ── Stock adjustment: transactional + audited, ADMIN only ───────────────

    test('PATCH /api/inventory/:id adjusts stock, writes a movement + audit row', async () => {
      const p = await createProduct(admin, { name: `Adj ${U()}`, initial_stock: 100 });
      const res = await request(app)
        .patch(`/api/inventory/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ delta: -40, reason: 'damaged in transit' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.available_quantity, 60);
      assert.strictEqual(res.body.movement.movement_type, 'manual_adjustment');

      const moves = await db.query(
        'SELECT quantity_delta, movement_type FROM inventory_movements WHERE product_id = $1',
        [p.id]
      );
      assert.strictEqual(moves.rowCount, 1);
      assert.strictEqual(Number(moves.rows[0].quantity_delta), -40);
      const audit = await db.query(
        "SELECT action FROM audit_logs WHERE entity_type = 'inventory' AND entity_id = $1",
        [p.id]
      );
      assert.strictEqual(audit.rows[0].action, 'STOCK_ADJUSTED');
    });

    test('PATCH /api/inventory/:id guards negative stock and rolls back the transaction', async () => {
      const p = await createProduct(admin, { name: `Neg ${U()}`, initial_stock: 10 });
      const bad = await request(app)
        .patch(`/api/inventory/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ delta: -11, reason: 'oversell attempt' });
      assert.strictEqual(bad.status, 409);
      assert.strictEqual(bad.body.error.code, 'INSUFFICIENT_STOCK');
      const inv = await db.query('SELECT physical_quantity FROM inventory WHERE product_id = $1', [
        p.id,
      ]);
      assert.strictEqual(Number(inv.rows[0].physical_quantity), 10, 'rolled back');
      const moves = await db.query('SELECT 1 FROM inventory_movements WHERE product_id = $1', [
        p.id,
      ]);
      assert.strictEqual(moves.rowCount, 0, 'no movement written for a rolled-back adjustment');
    });

    test('PATCH /api/inventory/:id: role + input + existence checks', async () => {
      const p = await createProduct(admin, { name: `Auth ${U()}`, initial_stock: 50 });
      assert.strictEqual(
        (await request(app).patch(`/api/inventory/${p.id}`).send({ delta: 5, reason: 'r' })).status,
        401
      );
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/inventory/${p.id}`)
            .set('Authorization', `Bearer ${customer.token}`)
            .send({ delta: 5, reason: 'r' })
        ).status,
        403
      );
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/inventory/${p.id}`)
            .set('Authorization', `Bearer ${agent.token}`)
            .send({ delta: 5, reason: 'r' })
        ).status,
        403,
        'adjustment is ADMIN-only'
      );
      // zero delta and missing reason → 400
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/inventory/${p.id}`)
            .set('Authorization', `Bearer ${admin.token}`)
            .send({ delta: 0, reason: 'r' })
        ).status,
        400
      );
      assert.strictEqual(
        (
          await request(app)
            .patch(`/api/inventory/${p.id}`)
            .set('Authorization', `Bearer ${admin.token}`)
            .send({ delta: 5 })
        ).status,
        400
      );
      // receipt (+delta) and threshold change
      const receipt = await request(app)
        .patch(`/api/inventory/${p.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ delta: 25, reason: 'restock', low_stock_threshold: 30 });
      assert.strictEqual(receipt.status, 200);
      assert.strictEqual(receipt.body.data.available_quantity, 75);
      assert.strictEqual(receipt.body.data.low_stock_threshold, 30);
      assert.strictEqual(receipt.body.movement.movement_type, 'stock_receipt');

      // nonexistent product → 404, nothing written
      const ghost = await request(app)
        .patch('/api/inventory/99999999')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ delta: 1, reason: 'r' });
      assert.strictEqual(ghost.status, 404);
    });

    // ── Password hash never exposed ─────────────────────────────────────────

    test('product responses never leak internal columns', async () => {
      const p = await createProduct(admin, { name: `Sec ${U()}` });
      const body = JSON.stringify(p);
      assert.ok(!body.includes('$2b$'), 'bcrypt hash leaked');
      assert.ok(!('password_hash' in p));
    });
  }
);
