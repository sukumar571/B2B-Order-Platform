'use strict';

/**
 * Application error carrying an HTTP status and a stable machine code.
 * The central error handler (middleware/errorHandler.js) maps these to the
 * consistent JSON error envelope defined in docs/api-specification.md §3.
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace && Error.captureStackTrace(this, ApiError);
  }

  static notFound(message = 'Route not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static conflict(code, message, details) {
    return new ApiError(409, code, message, details);
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}

module.exports = { ApiError };
