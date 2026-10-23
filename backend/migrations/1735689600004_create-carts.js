'use strict';

/**
 * 04 — carts
 * Exactly one cart per customer is a DB guarantee (UNIQUE), not application
 * politeness (FR-CART-01). Cart totals are never stored — they are computed
 * from live prices at read time (transient; orders are the record).
 */
exports.up = (pgm) => {
  pgm.createTable('carts', {
    id: { type: 'bigserial', primaryKey: true },
    customer_id: { type: 'bigint', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('carts', 'carts_customer_fk', {
    foreignKeys: { columns: 'customer_id', references: 'users(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('carts', 'carts_customer_uq', { unique: 'customer_id' });
};

exports.down = (pgm) => {
  pgm.dropTable('carts');
};
