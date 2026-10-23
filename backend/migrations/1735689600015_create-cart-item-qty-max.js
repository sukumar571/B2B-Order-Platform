'use strict';

/**
 * 15 — cart line maximum (Phase 6)
 * The documented per-line quantity ceiling (backend/src/constants/cart.js,
 * CART_MAX_LINE_QTY) is mirrored as a database CHECK so it is a hard guarantee,
 * not just application validation. `quantity >= 1` already exists from
 * migration 05 (cart_item_qty_positive); this adds the upper bound.
 */
const { CART_MAX_LINE_QTY } = require('../src/constants/cart');

exports.up = (pgm) => {
  pgm.addConstraint('cart_items', 'cart_item_qty_max', {
    check: `quantity <= ${CART_MAX_LINE_QTY}`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('cart_items', 'cart_item_qty_max', { ifExists: true });
};
