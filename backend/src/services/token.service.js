'use strict';

/**
 * JWT access tokens + opaque rotating refresh tokens (docs/decision-log.md D-19).
 *
 *  - Access token: short-lived JWT (HS256 ONLY — the algorithm is pinned on
 *    both sign and verify, so `alg: none` / algorithm-confusion tricks fail),
 *    carrying sub / role / typ and validated iss + aud on every request.
 *  - Refresh token: 256-bit opaque random string wrapped in a JWT envelope;
 *    only its SHA-256 hash is persisted (refresh_tokens.token_hash), so a
 *    database dump cannot be replayed. Rotation + family revocation detect
 *    reuse of a spent token (likely theft) by revoking the whole chain.
 *
 * This module performs NO I/O and never logs token material (R-06).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

const TOKEN_TYPE = { ACCESS: 'access', REFRESH: 'refresh' };
const ALGORITHM = 'HS256';

function signOptions(ttl) {
  return {
    algorithm: ALGORITHM,
    expiresIn: ttl,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  };
}

// Verification pins the accepted algorithm set (blocks alg:none / confusion).
const VERIFY_OPTIONS = {
  algorithms: [ALGORITHM],
  issuer: config.jwtIssuer,
  audience: config.jwtAudience,
};

function signAccessToken({ userId, role }) {
  return jwt.sign(
    { sub: String(userId), role, typ: TOKEN_TYPE.ACCESS },
    config.jwtAccessSecret,
    signOptions(config.jwtAccessTtl)
  );
}

/**
 * Create a refresh token pair:
 *   raw   — the ONLY usable secret (sent to the client in an HttpOnly cookie)
 *   hash  — what we store (hex SHA-256 of raw)
 * The envelope JWT carries sub + jti=hash so orphaned cookies map to a user.
 */
function signRefreshToken({ userId, familyId }) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = sha256Hex(raw);
  const envelope = jwt.sign(
    { sub: String(userId), jti: hash, fam: familyId, typ: TOKEN_TYPE.REFRESH },
    config.jwtRefreshSecret,
    signOptions(config.jwtRefreshTtl)
  );
  return { raw, hash, envelope };
}

/** Verify signature, expiry, pinned algorithm, iss and aud. Returns payload or null. */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwtAccessSecret, VERIFY_OPTIONS);
  } catch {
    return null;
  }
}

function verifyRefreshEnvelope(token) {
  try {
    return jwt.verify(token, config.jwtRefreshSecret, VERIFY_OPTIONS);
  } catch {
    return null;
  }
}

/** True only for a genuine access token — refresh envelopes must NOT work as bearer tokens. */
function isAccessPayload(payload) {
  return Boolean(payload) && payload.typ === TOKEN_TYPE.ACCESS && payload.sub !== undefined;
}

function sha256Hex(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/** Parse `Authorization: Bearer <jwt>` (case-insensitive scheme). */
function extractBearer(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Seconds until expiry, floored at 0 — used for cookie maxAge alignment. */
function refreshTtlSeconds() {
  return (
    jwt.decode(
      signRefreshToken({ userId: '0', familyId: '00000000-0000-0000-0000-000000000000' }).envelope,
      {
        complete: true,
      }
    ).payload.exp - Math.floor(Date.now() / 1000)
  );
}

module.exports = {
  TOKEN_TYPE,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshEnvelope,
  isAccessPayload,
  sha256Hex,
  extractBearer,
  refreshTtlSeconds,
};
