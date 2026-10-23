'use strict';

const { getHealth } = require('../services/health.service');

/**
 * Health controller — thin HTTP adapter. No business logic here
 * (docs/architecture.md §4). Returns 503 when the database is configured but
 * unreachable (FR-AUD-04).
 */
async function healthHandler(_req, res, next) {
  try {
    const health = await getHealth();
    const { httpStatus, ...body } = health;
    res.status(httpStatus).json(body);
  } catch (err) {
    next(err);
  }
}

module.exports = { healthHandler };
