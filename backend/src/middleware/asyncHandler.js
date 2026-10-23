'use strict';

/**
 * Wrap an async route handler so rejected promises reach the centralized
 * error handler (Express 4 does not catch async throws natively).
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
