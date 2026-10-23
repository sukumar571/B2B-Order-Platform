'use strict';

/**
 * 10 — inventory_movements
 * Append-only ledger of every stock change (FR-CAT-06). Reconciliation
 * invariant the test suite asserts: for each product, the signed sum of
 * physical-affecting deltas equals physical_quantity and the reserved-affecting
 * deltas equal reserved_quantity. Movement types map to the stock model:
 *   stock_receipt / manual_adjustment   -> physical_quantity
 *   order_reservation                   -> reserved_quantity (+qty)
 *   cancellation_release                -> reserved_quantity (-qty)
 *   fulfillment_consumption             -> both (-qty)
 * (delta sign always carries the direction; type documents the cause).
 */
exports.up = (pgm) => {
  pgm.createTable('inventory_movements', {
    id: { type: 'bigserial', primaryKey: true },
    product_id: { type: 'bigint', notNull: true },
    performed_by: { type: 'bigint', notNull: true },
    quantity_delta: { type: 'integer', notNull: true },
    movement_type: { type: 'varchar(30)', notNull: true },
    order_id: { type: 'bigint' },
    reason: { type: 'varchar(300)', notNull: true, default: '' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('inventory_movements', 'movements_product_fk', {
    foreignKeys: { columns: 'product_id', references: 'products(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('inventory_movements', 'movements_performed_by_fk', {
    foreignKeys: { columns: 'performed_by', references: 'users(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('inventory_movements', 'movements_order_fk', {
    foreignKeys: { columns: 'order_id', references: 'orders(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('inventory_movements', 'movement_delta_nonzero', {
    check: 'quantity_delta <> 0',
  });
  pgm.addConstraint('inventory_movements', 'movement_type_valid', {
    check: `movement_type IN ('stock_receipt', 'manual_adjustment', 'order_reservation', 'cancellation_release', 'fulfillment_consumption')`,
  });

  pgm.createIndex('inventory_movements', 'product_id', { name: 'movements_product_idx' });
  pgm.createIndex('inventory_movements', 'order_id', { name: 'movements_order_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('inventory_movements');
};
