'use strict';

/**
 * 13 — refresh_tokens (Phase 4 authentication)
 *
 * Refresh tokens are opaque random secrets bound to a JWT envelope. Only the
 * SHA-256 hash of the opaque token is stored — a database leak cannot be
 * replayed as a live token. `family_id` groups one login's rotation chain so
 * reuse of a rotated-out token revokes the entire family (steal detection).
 *
 * Rows are credentials, not history: they cascade with the user and are
 * eligible for expiry cleanup (reverse of D-11 "never erase" — audit_logs
 * remains the permanent record).
 */
exports.up = (pgm) => {
  pgm.createTable('refresh_tokens', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'bigint', notNull: true },
    token_hash: { type: 'char(64)', notNull: true },
    family_id: { type: 'uuid', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    replaced_by_hash: { type: 'char(64)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('refresh_tokens', 'refresh_tokens_user_id_fkey', {
    foreignKeys: { columns: 'user_id', references: 'users(id)', onDelete: 'CASCADE' },
  });
  pgm.addConstraint('refresh_tokens', 'refresh_tokens_hash_uq', { unique: 'token_hash' });
  pgm.addConstraint('refresh_tokens', 'refresh_tokens_expiry_valid', {
    check: 'expires_at > created_at',
  });

  // Hot lookups happen by token hash; family revocation scans by family.
  pgm.createIndex('refresh_tokens', 'family_id');
  pgm.createIndex('refresh_tokens', 'user_id');
  pgm.createIndex('refresh_tokens', 'expires_at');
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
};
