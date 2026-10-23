'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/env');

/**
 * Rate limiting for sensitive authentication endpoints (risk-register R-08:
 * brute-force credential stuffing / password spraying).
 *
 *  - loginRateLimiter  → POST /api/auth/login, POST /api/auth/refresh
 *  - registerRateLimiter → POST /api/auth/register (stricter: account spam)
 *
 * Fixed-window, keyed by client IP. The 429 response uses the same error
 * envelope as every other failure. No credentials are ever logged — and the
 * limiter itself is silent.
 *
 * Tests skip limiting by default (flakiness defence); dedicated tests set
 * B2B_ENFORCE_RATE_LIMIT=1 to exercise the real 429 behaviour.
 */

const SKIP = () => config.isTest && process.env.B2B_ENFORCE_RATE_LIMIT !== '1';

/**
 * Test runs partition buckets by an X-Test-Bucket header (sent only by the
 * integration suite) so many sequential test cases — all from 127.0.0.1 —
 * do not starve each other. Production always keys on the client IP.
 */
const keyGenerator = (req) =>
  config.isTest && process.env.B2B_ENFORCE_RATE_LIMIT === '1' && req.headers['x-test-bucket']
    ? String(req.headers['x-test-bucket'])
    : rateLimit.ipKeyGenerator(req.ip);

const handler = (_req, res, _next, _options) => {
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many attempts — please try again later' },
  });
};

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  skip: SKIP,
  keyGenerator,
};

const loginRateLimiter = rateLimit({
  ...base,
  windowMs: config.authRateWindowMs,
  limit: config.authRateMax,
});

const registerRateLimiter = rateLimit({
  ...base,
  windowMs: config.authRateWindowMs,
  limit: config.registerRateMax,
});

module.exports = { loginRateLimiter, registerRateLimiter };
