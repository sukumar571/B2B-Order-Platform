'use strict';

const logger = require('../utils/logger');

/**
 * Lightweight request logger. Records method, path, status, and duration.
 * Never logs request bodies or auth headers (requirements.md FR-AUD-05).
 */
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('http.request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(ms * 10) / 10,
    });
  });
  next();
}

module.exports = { requestLogger };
