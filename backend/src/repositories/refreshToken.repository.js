'use strict';

/**
 * Data access for `refresh_tokens` — parameterized SQL only (C-04).
 * Only SHA-256 hashes of opaque tokens are stored; raw token material never
 * touches the database, logs, or responses (risk-register R-06).
 */

const { query } = require('../db/pool');

/**
 * Record a freshly issued refresh token.
 * `expiresAt` must be a Date in the future (DB CHECK enforces it).
 */
async function insertRefreshToken({ userId, tokenHash, familyId, expiresAt }) {
  const r = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, family_id, expires_at`,
    [userId, tokenHash, familyId, expiresAt]
  );
  return r.rows[0];
}

/** Look up the stored row for a presented token hash (null when unknown). */
async function findRefreshTokenByHash(tokenHash) {
  const r = await query(
    `SELECT id, user_id, token_hash, family_id, expires_at, revoked_at, created_at
     FROM refresh_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );
  return r.rows[0] || null;
}

/** Mark a single token as spent (rotation) — idempotent. */
async function revokeRefreshToken(id, replacedByHash = null) {
  await query(
    `UPDATE refresh_tokens
     SET revoked_at = now(), replaced_by_hash = COALESCE($2, replaced_by_hash)
     WHERE id = $1 AND revoked_at IS NULL`,
    [id, replacedByHash]
  );
}

/**
 * Revoke every live token in a rotation family — used on logout AND on
 * reuse detection (a spent token being replayed means the chain was likely
 * stolen, so the whole session lineage dies at once).
 */
async function revokeFamily(familyId) {
  const r = await query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId]
  );
  return r.rowCount;
}

/**
 * Revoke all live tokens for a user (admin kill-switch / future use).
 */
async function revokeAllForUser(userId) {
  const r = await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return r.rowCount;
}

/**
 * Hygiene: delete tokens that expired, or were revoked, more than `graceDays`
 * ago. Safe by design — expired rows can no longer authenticate, revoked rows
 * must not resurrect; audit_logs remains the permanent record (D-11).
 * Returns the number of rows removed.
 */
async function purgeExpired(graceDays = 30) {
  const r = await query(
    `DELETE FROM refresh_tokens
     WHERE (expires_at < now() - make_interval(days => $1::int))
        OR (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1::int))`,
    [graceDays]
  );
  return r.rowCount;
}

module.exports = {
  insertRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshToken,
  revokeFamily,
  revokeAllForUser,
  purgeExpired,
};
