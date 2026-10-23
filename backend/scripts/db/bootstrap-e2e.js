'use strict';

/**
 * E2E database bootstrap — Phase 12 QA automation.
 *
 *   DATABASE_URL_E2E=postgres://.../b2b_oms_e2e node scripts/db/bootstrap-e2e.js
 *
 * Provisions a FULLY DISPOSEBLE end-to-end test database from scratch so the
 * browser suite always starts from a known, seeded state:
 *   1. DROP DATABASE IF EXISTS + CREATE DATABASE  (guarded — see below)
 *   2. apply all migrations (node-pg-migrate `up`)
 *   3. seed the dev accounts + products (non-destructive seed routine)
 *
 * ── SAFETY CONTRACT (mirrors NFR-14 / risk-register R-05, and the Phase 12
 *    "never touch a production DB / only reset an explicitly disposable one") ──
 *   - Requires an explicit DATABASE_URL_E2E. There is NO fallback.
 *   - The target database NAME must match /^[a-z0-9_]*_e2e$/i. Anything else
 *     (development, production, the integration `b2b_oms_test` DB, etc.) is
 *     REFUSED before a single connection is opened, so this script physically
 *     cannot drop real data.
 *   - The resolved URL must not equal DATABASE_URL (dev) or DATABASE_URL_TEST.
 *   - DROP/CREATE only ever runs against that *_e2e name on the same server,
 *     via the `postgres` maintenance database.
 */

const path = require('path');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const pm = require('node-pg-migrate');
const migrate = pm.default || pm;
const config = require('../../src/config/env'); // also loads backend/.env
const { DEV_PASSWORD, users, products } = require('../../../database/seeds/seed-data');

const e2eUrl = process.env.DATABASE_URL_E2E || '';

function fail(msg) {
  console.error(`bootstrap-e2e refused: ${msg}`);
  process.exit(1);
}

if (!e2eUrl) {
  fail('DATABASE_URL_E2E is not set. Point it at a disposable *_e2e database.');
}

const url = new URL(e2eUrl.replace('postgres://', 'postgresql://'));
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));

// Hard guard: only an explicitly disposable *_e2e database may be reset.
if (!/^[a-z0-9_]*_e2e$/i.test(dbName)) {
  fail(
    `"${dbName}" is not a disposable E2E database name (must end with "_e2e"). ` +
      'Refusing to drop anything.'
  );
}

// Belt-and-braces: never coincide with dev or the integration test DB.
function nameOf(connStr) {
  if (!connStr) return '';
  try {
    return decodeURIComponent(
      new URL(connStr.replace('postgres://', 'postgresql://')).pathname.replace(/^\//, '')
    );
  } catch {
    return '';
  }
}
if (
  dbName &&
  (dbName === nameOf(config.databaseUrl) || dbName === nameOf(config.databaseUrlTest))
) {
  fail(`"${dbName}" matches a configured development/test database — refusing to reset it.`);
}

function redact(u) {
  return u.replace(/\/\/[^@]*@/, '//***@');
}

(async () => {
  // 1) Drop + create on the maintenance database (same server, `postgres` db).
  const maint = new URL(e2eUrl.replace('postgres://', 'postgresql://'));
  maint.pathname = '/postgres';
  const admin = new Client({ connectionString: maint.toString() });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Recreated disposable E2E database "${dbName}".`);
  } finally {
    await admin.end().catch(() => {});
  }

  // 2) Migrate the fresh schema.
  await migrate({
    direction: 'up',
    databaseUrl: e2eUrl,
    dir: path.join(__dirname, '..', '..', 'migrations'),
    migrationsTable: 'pgmigrations',
    schema: 'public',
    verbose: false,
    log: () => {},
  });
  console.log(`Applied all migrations to ${redact(e2eUrl)}.`);

  // 3) Seed the dev accounts + products (idempotent-safe: the DB is brand new).
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: e2eUrl, max: 4 });
  const client = await pool.connect();
  try {
    const hash = await bcrypt.hash(DEV_PASSWORD, 10); // cost 10 keeps E2E setup quick (dev seeds only)
    await client.query('BEGIN');
    for (const u of users) {
      await client.query(
        `INSERT INTO users (email, password_hash, name, role, is_active)
         VALUES ($1, $2, $3, $4, $5)`,
        [u.email.toLowerCase(), hash, u.name, u.role, u.is_active !== false]
      );
    }
    for (const p of products) {
      const r = await client.query(
        `INSERT INTO products (sku, name, description, unit_price, tax_rate, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [p.sku, p.name, p.description, p.unit_price, p.tax_rate, p.is_active]
      );
      await client.query(
        `INSERT INTO inventory (product_id, physical_quantity, reserved_quantity)
         VALUES ($1, $2, $3)`,
        [r.rows[0].id, p.inventory.physical, p.inventory.reserved]
      );
    }
    await client.query('COMMIT');
    console.log(`Seeded ${users.length} users and ${products.length} products into "${dbName}".`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(`seed failed, rolled back: ${err.message}`);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
})().catch((err) => fail(err.message));
