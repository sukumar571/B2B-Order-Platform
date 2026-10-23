'use strict';

/**
 * Backend coverage runner — the reproducible way to measure line/branch/function
 * coverage of `src/` from the Node.js built-in test runner.
 *
 *   npm run coverage:backend      (root)   |   npm --prefix backend run test:coverage
 *
 * It mirrors scripts/db/run-integration-tests.js so the SHIPPED coverage number
 * reflects the whole suite (unit + REST/HTTP + PostgreSQL integration) rather
 * than only the DB-less unit files. Concretely:
 *
 *  1. Requires DATABASE_URL_TEST — the isolated test database. It refuses to run
 *     when unset so a coverage pass can NEVER point at development/prod data.
 *  2. Applies pending migrations to the test DB (idempotent, never drops).
 *  3. Spawns `node --test --experimental-test-coverage` with the opt-in DB flag
 *     (B2B_RUN_DB_TESTS=1) so the HTTP/integration files actually execute, and
 *     serializes files (--test-concurrency=1) because they share ONE test DB.
 *
 * No coverage *threshold* is enforced on purpose — see docs/test-plan.md. A gate
 * that fails the build at an arbitrary percentage hides untested code; here we
 * only MEASURE and report, so low spots (CLI-only entrypoints, defensive
 * branches) stay visible instead of being silently averaged away.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const config = require('../../src/config/env');

if (!config.databaseUrlTest) {
  console.error(
    [
      'DATABASE_URL_TEST is not set — backend coverage needs the isolated test database.',
      '',
      '  1. Start PostgreSQL:  docker compose up -d db',
      '  2. Create test DB:    npm run db:create:test',
      '',
      'Coverage will NOT run against DATABASE_URL (development data is never touched).',
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
  console.error('Migration of the test database failed — aborting coverage run.');
  process.exit(migrateProc.status ?? 1);
}

console.log('Running the full backend suite with V8 coverage…\n');
const testProc = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    // Serialize: every DB-backed file shares the ONE DATABASE_URL_TEST, and the
    // integration file includes a drop/recreate reversibility test.
    '--test-concurrency=1',
  ],
  {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      B2B_RUN_DB_TESTS: '1',
      B2B_ENFORCE_RATE_LIMIT: '1',
      NODE_ENV: 'test',
      DB_POOL_MAX: '30',
    },
  }
);
process.exit(testProc.status ?? 1);
