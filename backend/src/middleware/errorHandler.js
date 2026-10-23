'use strict';

const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Centralized, safe error handler (must have 4 args to be recognized by Express).
 * Never leaks stack traces, secrets, or raw internal error messages to clients;
 * logs a redacted record server-side instead
 * (docs/api-specification.md §3 INTERNAL_ERROR, risk-register R-06).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError && Number.isInteger(err.status) ? err.status : 500;

  // Body size limit violations surface as a body-parser entity.too.large error.
  if (err.type === 'entity.too.large' || err.code === 'entity.too.large') {
    const e = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit');
    return respond(e, req, res);
  }

  // Malformed JSON from express.json surfaces as a SyntaxError.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const e = new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    return respond(e, req, res);
  }

  const apiErr = err instanceof ApiError ? err : ApiError.internal('An unexpected error occurred');

  if (status >= 500) {
    logger.error('request.failed', {
      method: req.method,
      path: req.originalUrl,
      status,
      // Do not log err.message for 500s — it may contain internals.
    });
  }

  return respond(apiErr, req, res);
}

function respond(apiErr, req, res) {
  if (res.headersSent) return;
  const body = {
    error: {
      code: apiErr.code,
      message: apiErr.message,
    },
  };
  if (apiErr.details !== undefined) body.error.details = apiErr.details;
  res.status(apiErr.status).json(body);
}

module.exports = { errorHandler };
