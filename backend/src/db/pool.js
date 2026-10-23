'use strict';

/**
 * PostgreSQL connection pool (pg).
 *
 * Safety rules (docs/requirements.md NFR-14, risk-register R-05):
 *  - The pool only ever CONNECTS. Nothing in this module creates, drops, or
 *    truncates databases; that is exclusively the job of the explicit,
 *    human-run scripts under scripts/db/ (which also never drop).
 *  - All application queries go through query()/getClient() and MUST use
 *    parameterized SQL ($1, $2, ...) — never string interpolation (C-04).
 *
 * In test mode (NODE_ENV=test) the pool targets DATABASE_URL_TEST so
 * integration tests are fully isolated from development data.
 */

const { Pool } = require('pg');
const config = require('../config/env');

let pool = null;

/** Active database URL for the current mode ('' when not configured). */
function activeDatabaseUrl() {
  return config.isTest ? config.databaseUrlTest : config.databaseUrl;
}

/** True when a database URL is configured for the current mode. */
function isConfigured() {
  return activeDatabaseUrl() !== '';
}

/** Lazily create (and memoize) the shared pool. Throws if not configured. */
function getPool() {
  const connectionString = activeDatabaseUrl();
  if (!connectionString) {
    throw new Error(
      config.isTest
        ? 'DATABASE_URL_TEST is not configured (required for tests)'
        : 'DATABASE_URL is not configured'
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: config.dbPoolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    });
    // Surface async backend disconnects instead of crashing the process.
    pool.on('error', (err) => {
      console.error(
        JSON.stringify({ level: 'error', message: 'pg.pool.error', detail: err.message })
      );
    });
  }
  return pool;
}

/**
 * Run a single parameterized query.
 * Usage: await query('SELECT * FROM users WHERE id = $1', [id])
 */
async function query(text, params = []) {
  return getPool().query(text, params);
}

/**
 * Acquire a dedicated client (for transactions). Caller MUST release it.
 * Prefer withTransaction() below for anything that changes state.
 */
async function getClient() {
  return getPool().connect();
}

/**
 * Run `fn(client)` inside BEGIN/COMMIT with automatic ROLLBACK on any error,
 * always releasing the client. This is the building block for atomic business
 * transactions (stock reservation, order + audit writes) in Phase 4.
 */
async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already broken — PostgreSQL auto-rolls back on disconnect.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Non-throwing connectivity probe used by GET /api/health.
 * Returns { state: 'up' | 'down' | 'not_configured', detail? }.
 */
async function checkDatabase() {
  if (!isConfigured()) return { state: 'not_configured' };
  try {
    const started = Date.now();
    await getPool().query('SELECT 1');
    return { state: 'up', latencyMs: Date.now() - started };
  } catch (err) {
    return { state: 'down', detail: err.message };
  }
}

/** Close the pool (graceful shutdown / test teardown). Safe when unused. */
async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  activeDatabaseUrl,
  isConfigured,
  getPool,
  query,
  getClient,
  withTransaction,
  checkDatabase,
  closePool,
};
