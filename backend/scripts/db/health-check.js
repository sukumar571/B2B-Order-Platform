'use strict';

/**
 * Database initialization & connectivity health check (read-only).
 *
 *   npm run db:health            # checks DATABASE_URL
 *   npm run db:health:test       # checks DATABASE_URL_TEST
 *
 * Verifies (in order, all safe/read-only — nothing is created or dropped):
 *  1. TCP connectivity + auth (SELECT 1)
 *  2. PostgreSQL version
 *  3. Whether migrations are applied and the schema is complete
 * Outputs a JSON summary and exits 0 (healthy) or 1 (unreachable/incomplete).
 */

const config = require('../../src/config/env');
const { Pool } = require('pg');

const useTestDb = process.argv.includes('--test');
const connectionString = useTestDb ? config.databaseUrlTest : config.databaseUrl;

const EXPECTED_TABLES = [
  'audit_logs',
  'cart_items',
  'carts',
  'idempotency_keys',
  'invoice_counters',
  'invoices',
  'inventory',
  'inventory_movements',
  'order_items',
  'orders',
  'products',
  'refresh_tokens',
  'users',
];

if (!connectionString) {
  console.error(
    `Error: ${useTestDb ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is not set — cannot check database health.`
  );
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const report = { target: useTestDb ? 'DATABASE_URL_TEST' : 'DATABASE_URL', connected: false };
  try {
    const started = Date.now();
    await pool.query('SELECT 1');
    report.connected = true;
    report.latencyMs = Date.now() - started;

    const { rows } = await pool.query('SHOW server_version');
    report.serverVersion = rows[0].server_version;

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [EXPECTED_TABLES]
    );
    const found = new Set(tables.rows.map((r) => r.table_name));
    report.tablesFound = found.size;
    report.tablesExpected = EXPECTED_TABLES.length;
    report.missingTables = EXPECTED_TABLES.filter((t) => !found.has(t));
    report.schemaComplete = report.missingTables.length === 0;

    const mig = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'pgmigrations')`
    );
    if (mig.rows[0].exists) {
      const count = await pool.query('SELECT count(*)::int AS n FROM pgmigrations');
      report.appliedMigrations = count.rows[0].n;
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.schemaComplete ? 0 : 1;
  } catch (err) {
    console.log(JSON.stringify({ ...report, error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
