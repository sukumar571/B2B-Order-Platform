'use strict';

/**
 * 09 — invoice_counters (internal mechanism, not a business entity)
 * One row per calendar period (e.g. '2026-10'). Invoice numbering claims the
 * next value inside the fulfillment transaction via
 *   INSERT ... ON CONFLICT (period) DO UPDATE
 *     SET next_val = invoice_counters.next_val + 1
 *   RETURNING next_val
 * which is race-safe and gap-tolerant (D-10 / FR-INV-02).
 */
exports.up = (pgm) => {
  pgm.createTable('invoice_counters', {
    period: { type: 'varchar(7)', primaryKey: true },
    next_val: { type: 'bigint', notNull: true, default: 1 },
  });

  pgm.addConstraint('invoice_counters', 'invoice_counter_period_format', {
    check: `period ~ '^[0-9]{4}-[0-9]{2}$'`,
  });
  pgm.addConstraint('invoice_counters', 'invoice_counter_next_val_positive', {
    check: 'next_val >= 1',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('invoice_counters');
};
