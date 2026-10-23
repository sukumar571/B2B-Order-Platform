'use strict';

/**
 * 06 — orders
 * Status state machine (FR-ORD-07): pending -> confirmed -> fulfilled, with
 * pending/confirmed -> cancelled; fulfilled/cancelled are terminal. Transition
 * legality lives in the service layer; this CHECK limits the value domain.
 * Financial totals are snapshotted at creation and never recomputed;
 * NUMERIC equality makes `grand_total = subtotal + tax_total` a hard
 * DB-enforced invariant (NFR-07 / R-03).
 */
exports.up = (pgm) => {
  pgm.createTable('orders', {
    id: { type: 'bigserial', primaryKey: true },
    customer_id: { type: 'bigint', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: 'pending' },
    cancellation_reason: { type: 'varchar(500)' },
    subtotal: { type: 'numeric(12,2)', notNull: true, default: 0 },
    tax_total: { type: 'numeric(12,2)', notNull: true, default: 0 },
    grand_total: { type: 'numeric(12,2)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('orders', 'orders_customer_fk', {
    foreignKeys: { columns: 'customer_id', references: 'users(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('orders', 'order_status_valid', {
    check: `status IN ('pending', 'confirmed', 'fulfilled', 'cancelled')`,
  });
  // A cancelled order must carry a meaningful reason (FR-ORD-08).
  pgm.addConstraint('orders', 'order_cancellation_reason_required', {
    check: `status <> 'cancelled' OR (cancellation_reason IS NOT NULL AND char_length(trim(cancellation_reason)) >= 3)`,
  });
  pgm.addConstraint('orders', 'order_totals_non_negative', {
    check: 'subtotal >= 0 AND tax_total >= 0 AND grand_total >= 0',
  });
  pgm.addConstraint('orders', 'order_totals_consistent', {
    check: 'grand_total = subtotal + tax_total',
  });

  pgm.createIndex('orders', ['customer_id', 'created_at'], {
    name: 'orders_customer_created_idx',
  });
  pgm.createIndex('orders', 'status', { name: 'orders_status_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('orders');
};
