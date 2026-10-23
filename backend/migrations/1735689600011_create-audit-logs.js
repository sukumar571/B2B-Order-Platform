'use strict';

/**
 * 11 — audit_logs
 * Append-only history (FR-AUD-02). actor_id is nullable so failed logins from
 * unknown accounts are still recorded (FR-AUD-01); details is JSONB written
 * only through AuditService with whitelisted keys — never passwords/tokens
 * (FR-AUD-05). A DB trigger (not just app convention) blocks UPDATE/DELETE at
 * row level. Audit rows are inserted inside the same transaction as the
 * business change, so history and data commit or roll back together (NFR-13).
 */
exports.up = (pgm) => {
  pgm.createTable('audit_logs', {
    id: { type: 'bigserial', primaryKey: true },
    actor_id: { type: 'bigint' },
    actor_role: { type: 'varchar(20)' },
    action: { type: 'varchar(60)', notNull: true },
    entity_type: { type: 'varchar(30)', notNull: true },
    entity_id: { type: 'bigint' },
    details: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('audit_logs', 'audit_actor_fk', {
    foreignKeys: { columns: 'actor_id', references: 'users(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('audit_logs', 'audit_actor_role_valid', {
    check: `actor_role IS NULL OR actor_role IN ('admin', 'agent', 'customer')`,
  });
  pgm.addConstraint('audit_logs', 'audit_action_not_blank', {
    check: `char_length(trim(action)) >= 1`,
  });

  pgm.createIndex('audit_logs', ['entity_type', 'entity_id', 'created_at'], {
    name: 'audit_entity_idx',
  });
  pgm.createIndex('audit_logs', ['actor_id', 'created_at'], {
    name: 'audit_actor_idx',
  });
  pgm.createIndex('audit_logs', ['action', 'created_at'], {
    name: 'audit_action_idx',
  });

  // Row-level append-only enforcement.
  pgm.createFunction(
    'audit_append_only',
    [],
    { returns: 'trigger', language: 'plpgsql' },
    `
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only: % operations are forbidden', TG_OP;
      END;
    `
  );

  pgm.createTrigger('audit_logs', 'audit_logs_append_only', {
    when: 'BEFORE',
    operation: ['UPDATE', 'DELETE'],
    function: 'audit_append_only',
  });
};

exports.down = (pgm) => {
  pgm.dropTrigger('audit_logs', 'audit_logs_append_only', { ifExists: true });
  // v7 signature: dropFunction(name, params, options).
  pgm.dropFunction('audit_append_only', [], { ifExists: true, cascade: true });
  pgm.dropTable('audit_logs');
};
