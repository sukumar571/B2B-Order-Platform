'use strict';

/**
 * Cart domain constants.
 *
 * CART IS NOT A RESERVATION. Adding an item to a cart checks current
 * `available_quantity` purely as a courtesy so a customer is not told a
 * quantity is fine when it obviously cannot be shipped — it does NOT lock,
 * decrement or hold stock (FR-CART-04 / D-23). Stock is authoritative only at
 * order creation, where every line is re-verified under a
 * `SELECT … FOR UPDATE` row lock. Between a cart write and checkout the stock
 * may drop to zero, so cart reads always recompute availability live and flag
 * lines whose stored quantity now exceeds what is on hand.
 */

// Documented maximum quantity allowed on a single cart line (FR-CART / user
// requirement "enforce a documented maximum quantity per cart line"). The same
// value is mirrored as a database CHECK in migration 15, so an application
// bug can never persist a line above it.
const CART_MAX_LINE_QTY = 1000;

module.exports = { CART_MAX_LINE_QTY };
