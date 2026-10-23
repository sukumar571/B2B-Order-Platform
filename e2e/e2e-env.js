'use strict';

/**
 * Shared E2E environment (Phase 12).
 *
 * The disposable end-to-end database is DERIVED from the configured development
 * DATABASE_URL by swapping ONLY the database name to `b2b_oms_e2e`. This reuses
 * the same local server/credentials the dev stack already uses while guaranteeing
 * a distinct name that ends in `_e2e` — which is exactly the name the guarded
 * bootstrap script (backend/scripts/db/bootstrap-e2e.js) insists on, so a real
 * dev/prod database can never be targeted by accident.
 */

const path = require('path');
// Reuse the backend's own .env loader + config so nothing is hardcoded here.
const config = require(path.join(__dirname, '..', 'backend', 'src', 'config', 'env'));

function swapDbName(connectionString, dbName) {
  const u = new URL(connectionString.replace('postgres://', 'postgresql://'));
  u.pathname = `/${dbName}`;
  return u.toString().replace('postgresql://', 'postgres://');
}

if (!config.databaseUrl) {
  throw new Error(
    'E2E needs a configured DATABASE_URL (backend/.env) to derive the disposable *_e2e database.'
  );
}

const DATABASE_URL_E2E =
  process.env.DATABASE_URL_E2E || swapDbName(config.databaseUrl, 'b2b_oms_e2e');

const API_URL = process.env.E2E_API_URL || 'http://localhost:4000';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const BACKEND_PORT = Number(new URL(API_URL).port || 4000);

module.exports = { DATABASE_URL_E2E, API_URL, BASE_URL, BACKEND_PORT };
