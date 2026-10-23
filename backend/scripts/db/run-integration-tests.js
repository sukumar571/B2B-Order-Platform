'use strict';

/**
 * Integration test runner — the ONLY supported way to execute the database
 * test suites (tests/db-integration.test.js + tests/auth-http.test.js).
 *
 *   npm run test:integration
 *
 * What it does:
 *  1. Requires DATABASE_URL_TEST (the isolated test database). It refuses to
 *     run against DATABASE_URL so tests can never touch development data.
 *  2. Applies pending migrations to the test DB (idempotent, never drops).
 *  3. Spawns `node --test` with B2B_RUN_DB_TESTS=1 (the opt-in flag the test
 *     files check) and B2B_ENFORCE_RATE_LIMIT=1 (so the auth suite can prove
 *     the 429 behaviour), inheriting the exit code.
 *
 * Setting the flag via a spawned process keeps this cross-platform (no
 * `set`/`export` shell syntax in package.json).
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const config = require('../../src/config/env');

if (!config.databaseUrlTest) {
  console.error(
    [
      'DATABASE_URL_TEST is not set — integration tests need the isolated test database.',
      '',
      '  1. Start PostgreSQL:  docker compose up -d db',
      '  2. Copy env example:  copy backend\\.env.example backend\\.env',
      '  3. Create test DB:    npm run db:create:test',
      '',
      'Tests will NOT run against DATABASE_URL (development data is never touched).',
    ].join('\n')
  );
  process.exit(1);
}

console.log('Applying migrations to the test database…');
const migrateProc = spawnSync(
  process.execPath,
  [path.join(__dirname, 'migrate.js'), 'up', '--test'],
  { stdio: 'inherit' }
);
if (migrateProc.status !== 0) {
  console.error('Migration of the test database failed — aborting integration tests.');
  process.exit(migrateProc.status ?? 1);
}

console.log('Running database integration tests…\n');
const testProc = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    // Serialize the two files. Both suites share the ONE DATABASE_URL_TEST
    // database, and db-integration.test.js includes a "down --all, then up"
    // reversibility test that drops every table. node --test runs files in
    // parallel by default, so without this the auth suite can hit the DB while
    // it is being torn down (intermittent 500s) or collide on node-pg-migrate's
    // advisory lock ("Another migration is already running"). --test-concurrency=1
    // runs one file at a time, eliminating the cross-file race.
    '--test-concurrency=1',
    path.join(__dirname, '..', '..', 'tests', 'db-integration.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'auth-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'catalog-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'cart-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'order-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'invoice-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'audit-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'report-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'user-http.test.js'),
    path.join(__dirname, '..', '..', 'tests', 'security-http.test.js'),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      B2B_RUN_DB_TESTS: '1',
      B2B_ENFORCE_RATE_LIMIT: '1',
      NODE_ENV: 'test',
      // The order suite fires a 20-way concurrency test; each request opens a
      // short-lived claim + order + completion transaction, so give the pool
      // headroom to avoid connection-queue timeouts (test-only).
      DB_POOL_MAX: '30',
    },
  }
);
process.exit(testProc.status ?? 1);
