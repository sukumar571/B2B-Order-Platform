'use strict';

/**
 * 01 — users
 * Passwords are stored ONLY as bcrypt hashes (FR-AUTH-03); there is no
 * plaintext column anywhere. Emails are enforced lowercase so uniqueness is
 * case-insensitive without requiring the citext extension.
 */
exports.up = (pgm) => {
  pgm.createTable('users', {
    id: { type: 'bigserial', primaryKey: true },
    email: { type: 'varchar(255)', notNull: true },
    password_hash: { type: 'varchar(100)', notNull: true },
    name: { type: 'varchar(120)', notNull: true },
    role: { type: 'varchar(20)', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('users', 'users_email_uq', { unique: 'email' });
  pgm.addConstraint('users', 'user_role_valid', {
    check: `role IN ('admin', 'agent', 'customer')`,
  });
  pgm.addConstraint('users', 'user_email_lowercase', {
    check: `email = lower(email)`,
  });
  pgm.addConstraint('users', 'user_name_not_blank', {
    check: `char_length(trim(name)) >= 1`,
  });
};

exports.down = (pgm) => {
  pgm.dropTable('users');
};
