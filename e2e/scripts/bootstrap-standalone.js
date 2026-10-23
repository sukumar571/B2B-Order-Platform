'use strict';

/**
 * Standalone wrapper around the guarded E2E database bootstrap so it can be run
 * on its own (`npm --prefix e2e run bootstrap`) as well as from globalSetup.
 *
 * It derives DATABASE_URL_E2E exactly like the suite does (swap the dev DB name
 * to a `*_e2e` database) and hands off to backend/scripts/db/bootstrap-e2e.js,
 * which refuses to touch anything whose name does not end in `_e2e`.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { DATABASE_URL_E2E } = require('../e2e-env');

const proc = spawnSync(
  process.execPath,
  [path.join(__dirname, '..', '..', 'backend', 'scripts', 'db', 'bootstrap-e2e.js')],
  {
    cwd: path.join(__dirname, '..', '..', 'backend'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL_E2E },
  }
);

process.exit(proc.status === 0 ? 0 : 1);
