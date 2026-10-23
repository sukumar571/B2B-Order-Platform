'use strict';

/**
 * 14 — inventory.low_stock_threshold
 *
 * Defines the LOW-STOCK rule used by GET /api/inventory/low-stock (FR-CAT-05):
 *   a product is LOW-STOCK  <=>  available_quantity <= low_stock_threshold
 * (available_quantity is the DB-generated sellable figure: physical - reserved).
 *
 * Per-product threshold (not a global constant) because replenishment cadence
 * differs by SKU. Non-negative integer; a sensible default (20) keeps existing
 * rows meaningful without a data backfill. Reversible: drops just this column.
 */
exports.up = (pgm) => {
  pgm.addColumn('inventory', {
    low_stock_threshold: { type: 'integer', notNull: true, default: 20 },
  });

  pgm.addConstraint('inventory', 'inventory_low_stock_threshold_non_negative', {
    check: 'low_stock_threshold >= 0',
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('inventory', 'inventory_low_stock_threshold_non_negative', {
    ifExists: true,
  });
  pgm.dropColumn('inventory', 'low_stock_threshold', { ifExists: true });
};
