'use strict';

/**
 * Development seed script — idempotent and non-destructive.
 *
 *   npm run db:seed          # seeds the dev database (DATABASE_URL)
 *   npm run db:seed:test     # seeds DATABASE_URL_TEST
 *
 * Safety: if ANY rows already exist in users/products, seeding is skipped with
 * a message — it never deletes, truncates, or overwrites existing records.
 * All inserts run in a single transaction (all-or-nothing).
 * Passwords are stored as bcrypt hashes only (FR-AUTH-03). Dev-only creds.
 */

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const config = require('../../src/config/env');
const { DEV_PASSWORD, users, products } = require('../../../database/seeds/seed-data');
const { getPool, closePool } = require('../../src/db/pool');

const useTestDb = process.argv.includes('--test');
const targetUrl = useTestDb ? config.databaseUrlTest : config.databaseUrl;

if (!targetUrl) {
  console.error(
    `Error: ${useTestDb ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is not set — nothing to seed.`
  );
  process.exit(1);
}

// Pool for `--test` runs from a non-test environment (the pool module would
// otherwise pick DATABASE_URL from NODE_ENV).
let seedPool = null;

/**
 * Pool module resolves DATABASE_URL vs DATABASE_URL_TEST from NODE_ENV; for
 * `db:seed:test` we build a dedicated pool against the test URL instead.
 */
function getPoolForTarget() {
  if (useTestDb && !config.isTest) {
    seedPool = new Pool({ connectionString: targetUrl, max: 2 });
    return seedPool;
  }
  return getPool();
}

(async () => {
  const pool = getPoolForTarget();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*) FROM users)     AS users,
         (SELECT count(*) FROM products)  AS products`
    );
    if (Number(rows[0].users) > 0 || Number(rows[0].products) > 0) {
      console.log('Existing data found — seed skipped (nothing was changed).');
      return;
    }

    const hash = await bcrypt.hash(DEV_PASSWORD, 12);

    await client.query('BEGIN');
    const userIds = [];
    for (const u of users) {
      const r = await client.query(
        `INSERT INTO users (email, password_hash, name, role, is_active)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [u.email.toLowerCase(), hash, u.name, u.role, u.is_active !== false]
      );
      userIds.push(r.rows[0].id);
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
    console.log(
      `Seeded ${users.length} users (dev password: "${DEV_PASSWORD}") and ${products.length} products with inventory.`
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Seed failed, rolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    if (seedPool) await seedPool.end();
    else await closePool();
  }
})();
