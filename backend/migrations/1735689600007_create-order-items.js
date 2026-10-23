'use strict';

/**
 * 07 — order_items
 * HISTORICAL SNAPSHOTS (FR-ORD-04 / D-07): product_name, unit_price and
 * tax_rate are copied from the catalog at order time, so later price/name
 * edits can never change past orders or invoices (AC-ORD-06 / SC-04).
 * product_id keeps a RESTRICT FK: the referenced product cannot be deleted
 * once ordered; catalog "deletion" is a soft deactivate.
 */
exports.up = (pgm) => {
  pgm.createTable('order_items', {
    id: { type: 'bigserial', primaryKey: true },
    order_id: { type: 'bigint', notNull: true },
    product_id: { type: 'bigint', notNull: true },
    product_name: { type: 'varchar(160)', notNull: true },
    unit_price: { type: 'numeric(12,2)', notNull: true },
    tax_rate: { type: 'numeric(5,2)', notNull: true },
    quantity: { type: 'integer', notNull: true },
    line_total: { type: 'numeric(12,2)', notNull: true },
    line_tax: { type: 'numeric(12,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('order_items', 'order_items_order_fk', {
    foreignKeys: { columns: 'order_id', references: 'orders(id)', onDelete: 'cascade' },
  });
  pgm.addConstraint('order_items', 'order_items_product_fk', {
    foreignKeys: { columns: 'product_id', references: 'products(id)', onDelete: 'restrict' },
  });
  // One line per product per order (mirrors cart upsert semantics).
  pgm.addConstraint('order_items', 'order_items_order_product_uq', {
    unique: ['order_id', 'product_id'],
  });
  pgm.addConstraint('order_items', 'order_item_qty_positive', {
    check: 'quantity >= 1',
  });
  pgm.addConstraint('order_items', 'order_item_price_positive', {
    check: 'unit_price > 0',
  });
  pgm.addConstraint('order_items', 'order_item_tax_rate_range', {
    check: 'tax_rate >= 0 AND tax_rate <= 100',
  });
  // Exact decimal math: NUMERIC(12,2) x integer is exact, so equality holds.
  pgm.addConstraint('order_items', 'order_item_line_total_exact', {
    check: 'line_total = unit_price * quantity',
  });
  pgm.addConstraint('order_items', 'order_item_line_tax_non_negative', {
    check: 'line_tax >= 0',
  });

  pgm.createIndex('order_items', 'product_id', { name: 'order_items_product_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('order_items');
};
