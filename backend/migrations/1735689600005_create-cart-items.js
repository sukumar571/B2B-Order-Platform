'use strict';

/**
 * 05 — cart_items
 * UNIQUE (cart_id, product_id) enforces add-to-cart upsert semantics
 * (FR-CART-01 / AC-CART-01). No prices are stored here on purpose — cart
 * lines always reflect current catalog prices until checkout.
 */
exports.up = (pgm) => {
  pgm.createTable('cart_items', {
    id: { type: 'bigserial', primaryKey: true },
    cart_id: { type: 'bigint', notNull: true },
    product_id: { type: 'bigint', notNull: true },
    quantity: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('cart_items', 'cart_items_cart_fk', {
    foreignKeys: { columns: 'cart_id', references: 'carts(id)', onDelete: 'cascade' },
  });
  pgm.addConstraint('cart_items', 'cart_items_product_fk', {
    foreignKeys: { columns: 'product_id', references: 'products(id)', onDelete: 'restrict' },
  });
  pgm.addConstraint('cart_items', 'cart_items_cart_product_uq', {
    unique: ['cart_id', 'product_id'],
  });
  pgm.addConstraint('cart_items', 'cart_item_qty_positive', {
    check: 'quantity >= 1',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('cart_items');
};
