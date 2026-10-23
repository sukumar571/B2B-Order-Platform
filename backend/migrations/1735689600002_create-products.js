'use strict';

/**
 * 02 — products
 * Catalog master data. Money uses NUMERIC(12,2) (NFR-07, D-09). Products are
 * soft-deleted via is_active so history never dangles (FR-CAT-02); rows
 * referenced by orders/invoices are additionally protected by RESTRICT FKs
 * declared in later migrations.
 */
exports.up = (pgm) => {
  pgm.createTable('products', {
    id: { type: 'bigserial', primaryKey: true },
    sku: { type: 'varchar(50)', notNull: true },
    name: { type: 'varchar(160)', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    unit_price: { type: 'numeric(12,2)', notNull: true },
    tax_rate: { type: 'numeric(5,2)', notNull: true, default: 0 },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('products', 'products_sku_uq', { unique: 'sku' });
  pgm.addConstraint('products', 'product_price_positive', {
    check: 'unit_price > 0',
  });
  pgm.addConstraint('products', 'product_tax_rate_range', {
    check: 'tax_rate >= 0 AND tax_rate <= 100',
  });
  pgm.addConstraint('products', 'product_name_not_blank', {
    check: `char_length(trim(name)) >= 1`,
  });
  pgm.addConstraint('products', 'product_sku_not_blank', {
    check: `char_length(trim(sku)) >= 1`,
  });

  pgm.createIndex('products', 'name', { name: 'products_name_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('products');
};
