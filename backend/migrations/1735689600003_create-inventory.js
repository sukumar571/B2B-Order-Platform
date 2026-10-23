'use strict';

/**
 * 03 — inventory (1:1 with products)
 *
 * STOCK MODEL (docs/decision-log.md D-06/D-18):
 *   physical_quantity  — units physically on hand in the warehouse.
 *   reserved_quantity  — units claimed by live orders (pending/confirmed)
 *                        that have not been fulfilled or cancelled yet.
 *   available_quantity — GENERATED (physical - reserved): the sellable
 *                        quantity shown to customers and validated against
 *                        at order creation. Cannot be written directly.
 *
 * Lifecycle:
 *   order created     -> reserved_quantity += qty   (requires available >= qty)
 *   order cancelled   -> reserved_quantity -= qty   (release)
 *   order fulfilled   -> physical -= qty AND reserved -= qty (available unchanged)
 *   manual adjustment -> physical += delta          (receipt / correction)
 *
 * Kept as a separate hot table so FOR UPDATE row locks during ordering never
 * contend with catalog columns (NFR-05), with DB-level CHECKs as the final
 * overselling guard (risk-register R-01).
 */
exports.up = (pgm) => {
  pgm.createTable('inventory', {
    product_id: { type: 'bigint', primaryKey: true },
    physical_quantity: { type: 'integer', notNull: true, default: 0 },
    reserved_quantity: { type: 'integer', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Generated column via explicit DDL (kept out of the createTable shorthand
  // for portability across node-pg-migrate versions).
  pgm.sql(
    `ALTER TABLE inventory ADD COLUMN available_quantity integer NOT NULL
       GENERATED ALWAYS AS (physical_quantity - reserved_quantity) STORED`
  );

  pgm.addConstraint('inventory', 'inventory_product_fk', {
    foreignKeys: { columns: 'product_id', references: 'products(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('inventory', 'inventory_physical_non_negative', {
    check: 'physical_quantity >= 0',
  });
  pgm.addConstraint('inventory', 'inventory_reserved_non_negative', {
    check: 'reserved_quantity >= 0',
  });
  // Final overselling guard: reserved can never exceed what is on hand.
  pgm.addConstraint('inventory', 'inventory_available_non_negative', {
    check: 'physical_quantity - reserved_quantity >= 0',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('inventory');
};
