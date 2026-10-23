'use strict';

const { ApiError } = require('../utils/errors');

/**
 * Catch-all for unmatched routes. Placed after all routers so any
 * unmatched request produces the consistent JSON error envelope
 * (docs/api-specification.md §3).
 */
function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

module.exports = { notFoundHandler };
