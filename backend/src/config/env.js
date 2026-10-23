'use strict';

/**
 * Centralized environment configuration.
 * All secrets/values come from process.env only (requirements.md C-06, NFR-03).
 * This module applies safe defaults and validates what the API foundation and
 * the Phase 4 authentication layer need (JWT secrets, bcrypt cost, rate limits).
 */

// Minimal, dependency-free .env loader so the app runs before `dotenv` is added.
// It only sets variables that are not already present in process.env.
function loadDotEnv(filename) {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.resolve(__dirname, '..', '..', filename);
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
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

loadDotEnv('.env');

const NODE_ENV = process.env.NODE_ENV || 'development';

function parseIntEnv(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${value}"`);
  }
  return parsed;
}

// CORS: explicitly configured allow-list (docs/requirements.md §Security).
// Empty value => no cross-origin access granted (same-origin only).
const rawOrigins = process.env.CORS_ORIGINS || '';
const corsOrigins = rawOrigins
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const config = {
  nodeEnv: NODE_ENV,
  isTest: NODE_ENV === 'test',
  port: parseIntEnv(process.env.PORT, 4000, 'PORT'),
  // JSON body size limit (mitigates oversized-payload risk; see risk-register R-07/§Security).
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '100kb',
  corsOrigins,
  shutdownTimeoutMs: parseIntEnv(process.env.SHUTDOWN_TIMEOUT_MS, 10000, 'SHUTDOWN_TIMEOUT_MS'),
  // PostgreSQL (Phase 3). Empty string means "not configured" — the app must
  // never attempt to create/drop databases implicitly; see scripts/db/*.
  databaseUrl: process.env.DATABASE_URL || '',
  databaseUrlTest: process.env.DATABASE_URL_TEST || '',
  // Connection pool tuning.
  dbPoolMax: parseIntEnv(process.env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
  dbConnectionTimeoutMs: parseIntEnv(
    process.env.DB_CONNECTION_TIMEOUT_MS,
    5000,
    'DB_CONNECTION_TIMEOUT_MS'
  ),
  // --- Authentication (Phase 4) -------------------------------------------
  // Secrets MUST come from the environment (C-06). Short-lived access tokens
  // plus rotating refresh tokens — see docs/decision-log.md D-19.
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || '',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || '',
  jwtIssuer: process.env.JWT_ISSUER || 'b2b-oms',
  jwtAudience: process.env.JWT_AUDIENCE || 'b2b-oms-api',
  // Durations use jsonwebtoken notation: '900s', '15m', '7d' …
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '7d',
  bcryptRounds: parseIntEnv(process.env.BCRYPT_ROUNDS, 12, 'BCRYPT_ROUNDS'),
  // Refresh-token cookie hardening. SameSite=strict is the CSRF defence; the
  // cookie is HttpOnly and scoped to the /api/auth path. Secure is mandatory
  // outside development/test (HTTPS — NFR-04).
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // Rate limiting for sensitive auth endpoints (per IP, per fixed window).
  authRateWindowMs: parseIntEnv(
    process.env.AUTH_RATE_WINDOW_MS,
    15 * 60 * 1000,
    'AUTH_RATE_WINDOW_MS'
  ),
  authRateMax: parseIntEnv(process.env.AUTH_RATE_MAX, 10, 'AUTH_RATE_MAX'),
  registerRateMax: parseIntEnv(process.env.REGISTER_RATE_MAX, 5, 'REGISTER_RATE_MAX'),
};

// --- Phase 4 secret bootstrapping & production validation ------------------
const INSECURE_DEV_SECRET = 'dev-insecure-jwt-secret-change-me-0123456789';
if (!config.jwtAccessSecret) {
  if (config.nodeEnv === 'production') {
    throw new Error('JWT_ACCESS_SECRET must be set to a long random value in production');
  }
  config.jwtAccessSecret = INSECURE_DEV_SECRET;
}
if (!config.jwtRefreshSecret) {
  if (config.nodeEnv === 'production') {
    throw new Error('JWT_REFRESH_SECRET must be set to a long random value in production');
  }
  config.jwtRefreshSecret = `${INSECURE_DEV_SECRET}-refresh`;
}
if (config.nodeEnv === 'production') {
  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', config.jwtAccessSecret],
    ['JWT_REFRESH_SECRET', config.jwtRefreshSecret],
  ]) {
    if (value.length < 32 || value.startsWith('dev-insecure')) {
      throw new Error(`${name} is too weak for production (>= 32 chars, not the dev default)`);
    }
  }
  if (!config.cookieSecure) {
    throw new Error('COOKIE_SECURE must be true in production (HTTPS-only auth cookies)');
  }
}

module.exports = config;
