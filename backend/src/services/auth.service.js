'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config/env');
const { withTransaction, query } = require('../db/pool');
const userRepository = require('../repositories/user.repository');
const refreshRepository = require('../repositories/refreshToken.repository');
const tokenService = require('../services/token.service');
const { logAudit } = require('./audit.service');
const { ApiError } = require('../utils/errors');
const { registerSchema, loginSchema, validateInput } = require('../utils/validators');
const { ROLE_VALUES } = require('../constants/roles');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPE, AUDIT_OUTCOME } = require('../constants/audit');
const logger = require('../utils/logger');

/**
 * Best-effort security audit for the auth flow. Unlike a business mutation
 * (which is written inside its own transaction and rolls back with it), an
 * auth attempt has no data change to bind to — success AND failure are both
 * meaningful (FR-AUD-01), so they are written on the pool directly. An audit
 * write must NEVER alter an authentication outcome or leak detail, so failures
 * here are swallowed (logged server-side only). We store the attempted email
 * for failures (needed to identify the target account) but never a password.
 */
async function auditAuth(entry) {
  try {
    await logAudit({ query }, entry);
  } catch (err) {
    logger.warn('audit write failed (auth)', { action: entry.action, err: err.message });
  }
}

/**
 * Authentication domain logic (FR-AUTH-01..05).
 * The controller only does HTTP (cookies/status); everything that decides
 * allow/deny lives here. Password hashes never leave this layer — every
 * returned user object goes through toPublicUser().
 */

// Constant work factor even when the user does not exist: login always runs
// one bcrypt.compare so response timing does not reveal valid emails.
const DUMMY_HASH = bcrypt.hashSync('timing-equalization-dummy', config.bcryptRounds);

/** The only user shape the API ever returns — no password_hash, ever. */
function toPublicUser(user) {
  return {
    id: String(user.id),
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.created_at,
  };
}

function issueTokens(user, familyId) {
  const accessToken = tokenService.signAccessToken({ userId: user.id, role: user.role });
  const refresh = tokenService.signRefreshToken({ userId: user.id, familyId });
  const expiresAt = new Date(Date.now() + ttlMs(config.jwtRefreshTtl));
  return { accessToken, refresh, expiresAt, userId: user.id, familyId };
}

/** Persist the freshly issued refresh hash (call inside the login flow). */
async function persistRefresh({ refresh, expiresAt, userId, familyId }) {
  await refreshRepository.insertRefreshToken({
    userId,
    tokenHash: refresh.hash,
    familyId,
    expiresAt,
  });
  return refresh.envelope;
}

/**
 * POST /api/auth/register — CUSTOMER accounts ONLY.
 * The role is hard-coded; any `role` field in the payload was already
 * rejected by the strict schema. Insert + default-cart creation are atomic.
 */
async function register(payload) {
  const input = validateInput(registerSchema, payload);
  const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);

  let created;
  try {
    created = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role, is_active, created_at`,
        [input.email, passwordHash, input.name, ROLE_VALUES.CUSTOMER]
      );
      const user = r.rows[0];
      await client.query(`INSERT INTO carts (customer_id) VALUES ($1)`, [user.id]);
      // Account creation is a business change, so its audit row is written in
      // the SAME transaction (NFR-13). No email/password in details — actor_id
      // identifies the subject and the role is the only fact worth keeping.
      await logAudit(client, {
        actorId: user.id,
        actorRole: user.role,
        action: AUDIT_ACTIONS.USER_REGISTERED,
        entityType: AUDIT_ENTITY_TYPE.USER,
        entityId: user.id,
        details: { role: user.role },
        outcome: AUDIT_OUTCOME.SUCCESS,
      });
      return user;
    });
  } catch (err) {
    const pgCode = err.code || (err.originalError && err.originalError.code);
    if (pgCode === '23505') {
      throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }

  const tokens = issueTokens(created, crypto.randomUUID());
  const refreshToken = await persistRefresh(tokens);
  return { user: toPublicUser(created), accessToken: tokens.accessToken, refreshToken };
}

/**
 * POST /api/auth/login — safe, consistent errors:
 * unknown email OR wrong password → the identical 401 INVALID_CREDENTIALS.
 * Disabled account → 403 ACCOUNT_DISABLED (only reveals what the owner knows).
 */
async function login(payload) {
  const input = validateInput(loginSchema, payload);
  const user = await userRepository.findByEmail(input.email);
  const hash = user ? user.password_hash : DUMMY_HASH;
  const ok = await bcrypt.compare(input.password, hash);

  if (!user || !ok) {
    // Uniform 401 for unknown-email and bad-password so the response cannot
    // confirm which accounts exist. Audited as a FAILURE with the attempted
    // email (FR-AUD-01) — never the password.
    await auditAuth({
      actorId: null,
      actorRole: null,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: user ? user.id : null,
      details: { email: input.email, reason: 'invalid_credentials' },
      outcome: AUDIT_OUTCOME.FAILURE,
    });
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (!user.is_active) {
    await auditAuth({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.ACCOUNT_DISABLED_ATTEMPT,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: user.id,
      details: {},
      outcome: AUDIT_OUTCOME.FAILURE,
    });
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  }

  await auditAuth({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    entityType: AUDIT_ENTITY_TYPE.USER,
    entityId: user.id,
    details: {},
    outcome: AUDIT_OUTCOME.SUCCESS,
  });

  const tokens = issueTokens(user, crypto.randomUUID());
  const refreshToken = await persistRefresh(tokens);
  return { user: toPublicUser(user), accessToken: tokens.accessToken, refreshToken };
}

/**
 * POST /api/auth/refresh — rotation with reuse detection.
 * The presented cookie is the refresh envelope; its embedded jti is the
 * SHA-256 hash we stored. Unknown/forged/expired/revoked → 401. Reusing a
 * token that was ALREADY rotated out revokes the entire family (the chain
 * was likely stolen) and answers 401 TOKEN_REUSED.
 */
async function refresh(envelope) {
  if (!envelope) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is missing');
  }
  const payload = tokenService.verifyRefreshEnvelope(envelope);
  if (!payload || payload.typ !== tokenService.TOKEN_TYPE.REFRESH || !payload.jti) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }

  const stored = await refreshRepository.findRefreshTokenByHash(payload.jti);
  if (!stored) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }
  if (stored.revoked_at) {
    await refreshRepository.revokeFamily(stored.family_id);
    await auditAuth({
      actorId: stored.user_id,
      actorRole: null,
      action: AUDIT_ACTIONS.AUTH_TOKEN_REUSED,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: stored.user_id,
      details: { family_id: stored.family_id },
      outcome: AUDIT_OUTCOME.FAILURE,
    });
    throw new ApiError(401, 'TOKEN_REUSED', 'Refresh token reuse detected — session revoked');
  }
  if (new Date(stored.expires_at).getTime() <= Date.now()) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }

  const user = await userRepository.findById(stored.user_id);
  if (!user || !user.is_active) {
    // Deactivated mid-session: the chain dies with the user.
    await refreshRepository.revokeFamily(stored.family_id);
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }

  const tokens = issueTokens(user, stored.family_id); // same rotation family
  await refreshRepository.revokeRefreshToken(stored.id, tokens.refresh.hash);
  const refreshToken = await persistRefresh(tokens);
  return { user: toPublicUser(user), accessToken: tokens.accessToken, refreshToken };
}

/**
 * POST /api/auth/logout — revoke the whole token family for the presented
 * cookie (best-effort: an invalid cookie still returns 200 so clients can
 * always clean up). The controller clears the cookie header.
 */
async function logout(envelope) {
  const payload = envelope ? tokenService.verifyRefreshEnvelope(envelope) : null;
  if (payload && payload.typ === tokenService.TOKEN_TYPE.REFRESH && payload.jti) {
    const stored = await refreshRepository.findRefreshTokenByHash(payload.jti);
    if (stored) await refreshRepository.revokeFamily(stored.family_id);
  }
  return { message: 'Logged out' };
}

/** GET /api/auth/me — identity comes ONLY from the validated access token. */
async function me(userId) {
  const user = await userRepository.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return { user: toPublicUser(user) };
}

/** Parse '15m' / '7d' / '900s' / plain seconds into milliseconds. */
function ttlMs(notation) {
  const match = /^(\d+)([smhd]?)$/.exec(String(notation).trim());
  if (!match) throw new Error(`Invalid TTL notation: "${notation}"`);
  const n = Number(match[1]);
  const unit = match[2] || 's';
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  me,
  toPublicUser,
  ttlMs,
};
