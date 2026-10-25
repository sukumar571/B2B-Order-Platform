'use strict';

/**
 * Perf/benchmark environment resolver — shared by scripts/load/*.
 *
 * WHY THIS DOES NOT REQUIRE src/config/env:
 *   The pool module chooses DATABASE_URL (dev) vs DATABASE_URL_TEST (test) at
 *   require time based on NODE_ENV, and `config` is a cached module. The load
 *   harness must therefore set NODE_ENV=test + DATABASE_URL_TEST=<perf db> on
 *   process.env BEFORE it pulls in src/config, or the app could silently bind to
 *   the real development database. This helper reads DATABASE_URL from the raw
 *   environment (falling back to backend/.env) so it can derive the isolated
 *   benchmark URL without triggering that cache.
 *
 * SAFETY (NFR-14 / risk-register R-05 — benchmark never touches real data):
 *   - The perf database name defaults to `b2b_oms_perf` and may be overridden
 *     with PERF_DB_NAME.
 *   - It is validated against the same strict identifier pattern create-db uses.
 *   - It refuses to resolve to the development (`b2b_oms`) or test (`b2b_oms_test`)
 *     database, so a typo in PERF_DB_NAME can never point the load test at live data.
 */

const fs = require('fs');
const path = require('path');

/** Minimal, dependency-free backend/.env reader (only fills unset keys). */
function loadBackendDotEnv() {
  const envPath = path.resolve(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const SAFE_DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Development DATABASE_URL (never a benchmark DB — the source we clone from). */
function devDatabaseUrl() {
  loadBackendDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set — copy backend/.env.example to backend/.env first.');
  }
  return url;
}

function databaseNameOf(url) {
  const u = new URL(url.replace('postgres://', 'postgresql://'));
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

/**
 * Derive the isolated benchmark database URL by cloning the dev connection
 * string (host/port/user/password) and swapping only the database name.
 */
function resolvePerfDatabaseUrl() {
  const dev = devDatabaseUrl();
  const devName = databaseNameOf(dev);
  const perfName = process.env.PERF_DB_NAME || 'b2b_oms_perf';

  if (!SAFE_DB_NAME.test(perfName)) {
    throw new Error(`Unsafe PERF_DB_NAME: "${perfName}"`);
  }
  const protectedNames = new Set([devName, 'b2b_oms', 'b2b_oms_test']);
  if (protectedNames.has(perfName)) {
    throw new Error(
      `PERF_DB_NAME "${perfName}" collides with a protected database — ` +
        'the benchmark must run against a dedicated, isolated database.'
    );
  }

  const u = new URL(dev.replace('postgres://', 'postgresql://'));
  u.pathname = `/${perfName}`;
  return { perfUrl: u.toString(), perfName, devName };
}

module.exports = {
  devDatabaseUrl,
  resolvePerfDatabaseUrl,
  databaseNameOf,
};
