'use strict';

/**
 * Playwright global setup — provisions the isolated, disposable E2E database
 * once before any browser test runs (Phase 12).
 *
 * It spawns the GUARDED bootstrap (backend/scripts/db/bootstrap-e2e.js), which
 * refuses to touch any database whose name does not end in `_e2e`. Development
 * and production databases are therefore structurally out of reach.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { DATABASE_URL_E2E } = require('./e2e-env');

module.exports = async function globalSetup() {
  process.env.DATABASE_URL_E2E = DATABASE_URL_E2E;
  console.log(
    `\n[e2e] Bootstrapping disposable E2E database (${DATABASE_URL_E2E.replace(/\/\/[^@]*@/, '//***@')})…`
  );

  const proc = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'backend', 'scripts', 'db', 'bootstrap-e2e.js')],
    {
      cwd: path.join(__dirname, '..', 'backend'),
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL_E2E },
    }
  );

  if (proc.status !== 0) {
    throw new Error(`[e2e] E2E database bootstrap failed (exit ${proc.status}).`);
  }
  console.log('[e2e] E2E database ready.\n');
};
