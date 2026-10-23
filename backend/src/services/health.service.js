'use strict';

/**
 * Health service (docs/requirements.md FR-AUD-04, api-specification.md §2.7).
 * Reports process liveness plus PostgreSQL connectivity when a database URL is
 * configured. The DB probe never throws — connection failures degrade the
 * report to status 'degraded' (HTTP 503) instead of crashing the endpoint.
 */

const { checkDatabase } = require('../db/pool');

const startedAt = Date.now();

async function getHealth() {
  const db = await checkDatabase();
  const dbOk = db.state !== 'down';
  return {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
    db: {
      state: db.state, // 'up' | 'down' | 'not_configured'
      ...(db.latencyMs !== undefined ? { latencyMs: db.latencyMs } : {}),
    },
    httpStatus: dbOk ? 200 : 503,
  };
}

module.exports = { getHealth };
