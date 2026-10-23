'use strict';

/**
 * 12 — idempotency_keys
 * Safe duplicate-request mechanism for order creation (D-08 / FR-ORD-06).
 * INSERTing the claim row is the atomic acquisition: UNIQUE
 * (user_id, idempotency_key) makes it impossible for two racing requests to
 * both proceed, and 'completed' rows let the original response be replayed.
 * Rows expire (24 h) and are pruned by a scheduled job in a later phase.
 */
exports.up = (pgm) => {
  pgm.createTable('idempotency_keys', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'bigint', notNull: true },
    idempotency_key: { type: 'varchar(64)', notNull: true },
    request_scope: { type: 'varchar(120)', notNull: true },
    status: { type: 'varchar(15)', notNull: true, default: 'in_progress' },
    response_status: { type: 'smallint' },
    response_body: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
  });

  pgm.addConstraint('idempotency_keys', 'idempotency_user_fk', {
    foreignKeys: { columns: 'user_id', references: 'users(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_user_key_uq', {
    unique: ['user_id', 'idempotency_key'],
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_status_valid', {
    check: `status IN ('in_progress', 'completed', 'failed')`,
  });
  // A completed record must carry the response it replays.
  pgm.addConstraint('idempotency_keys', 'idempotency_completed_has_response', {
    check: `status <> 'completed' OR (response_status IS NOT NULL AND response_body IS NOT NULL)`,
  });

  pgm.createIndex('idempotency_keys', 'expires_at', { name: 'idempotency_expires_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('idempotency_keys');
};
