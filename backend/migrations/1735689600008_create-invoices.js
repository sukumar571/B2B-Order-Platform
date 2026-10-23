'use strict';

/**
 * 08 — invoices
 * Created atomically with the fulfilled transition (FR-INV-01). UNIQUE
 * (order_id) makes double-invoicing impossible even under races or bugs
 * (FR-INV-05 / AC-INV-03); UNIQUE (invoice_number) protects the legal
 * numbering. Totals are denormalized snapshots that must equal the order
 * totals (AC-INV-01). RESTRICT on order/customer deletes preserves the
 * financial record (database-design §2.7).
 */
exports.up = (pgm) => {
  pgm.createTable('invoices', {
    id: { type: 'bigserial', primaryKey: true },
    order_id: { type: 'bigint', notNull: true },
    invoice_number: { type: 'varchar(30)', notNull: true },
    issued_by: { type: 'bigint', notNull: true },
    issued_date: { type: 'date', notNull: true, default: pgm.func('current_date') },
    subtotal: { type: 'numeric(12,2)', notNull: true },
    tax_total: { type: 'numeric(12,2)', notNull: true },
    grand_total: { type: 'numeric(12,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('invoices', 'invoices_order_fk', {
    foreignKeys: { columns: 'order_id', references: 'orders(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('invoices', 'invoices_issued_by_fk', {
    foreignKeys: { columns: 'issued_by', references: 'users(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('invoices', 'invoices_order_uq', { unique: 'order_id' });
  pgm.addConstraint('invoices', 'invoices_number_uq', { unique: 'invoice_number' });
  pgm.addConstraint('invoices', 'invoice_number_format', {
    check: `invoice_number ~ '^INV-[0-9]{4}-[0-9]{6}$'`,
  });
  pgm.addConstraint('invoices', 'invoice_totals_non_negative', {
    check: 'subtotal >= 0 AND tax_total >= 0 AND grand_total >= 0',
  });
  pgm.addConstraint('invoices', 'invoice_totals_consistent', {
    check: 'grand_total = subtotal + tax_total',
  });

  pgm.createIndex('invoices', 'issued_date', { name: 'invoices_issued_date_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('invoices');
};
