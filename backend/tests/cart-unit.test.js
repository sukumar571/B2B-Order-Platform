'use strict';

/**
 * Phase 6 — pure unit tests for the cart layer. No database: these pin down the
 * integer-cent money math (D-09, AC-CART-02 fixture) and the cart input
 * validators (quantity rules, product-id parsing, strict rejection of any
 * client-supplied owner field) before the HTTP+DB suite exercises them live.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const money = require('../src/utils/money');
const { CART_MAX_LINE_QTY } = require('../src/constants/cart');
const {
  validateInput,
  addCartItemSchema,
  updateCartItemSchema,
  cartItemIdParamSchema,
} = require('../src/utils/validators');

// ── Money (D-09 / AC-CART-02 / NFR-07) ──────────────────────────────────────

describe('money.toCents / fromCents', () => {
  test('round-trips 2-decimal strings exactly', () => {
    assert.strictEqual(money.toCents('19.99'), 1999);
    assert.strictEqual(money.toCents('20'), 2000);
    assert.strictEqual(money.toCents('0.05'), 5);
    assert.strictEqual(money.fromCents(1999), '19.99');
    assert.strictEqual(money.fromCents(5), '0.05');
    assert.strictEqual(money.fromCents(0), '0.00');
  });

  test('rejects malformed money with more than 2 decimals or negatives', () => {
    assert.throws(() => money.toCents('1.999'));
    assert.throws(() => money.toCents('-5'));
    assert.throws(() => money.toCents('abc'));
  });
});

describe('money.computeLine (AC-CART-02 fixture)', () => {
  test('19.99 × 3 @ 7.5% → line_total 59.97, line_tax 4.50 (half-up)', () => {
    const line = money.computeLine({ unit_price: '19.99', tax_rate: '7.50', quantity: 3 });
    assert.strictEqual(line.line_total, '59.97');
    assert.strictEqual(line.line_tax, '4.50');
  });

  test('tax rounds HALF-UP at the .5 boundary', () => {
    // 1.00 × 1 @ 12.5% → 0.125 → half-up → 0.13
    assert.strictEqual(
      money.computeLine({ unit_price: '1.00', tax_rate: '12.50', quantity: 1 }).line_tax,
      '0.13'
    );
    // 1.00 × 1 @ 12.4% → 0.124 → 0.12
    assert.strictEqual(
      money.computeLine({ unit_price: '1.00', tax_rate: '12.40', quantity: 1 }).line_tax,
      '0.12'
    );
  });

  test('zero tax rate yields zero tax', () => {
    const line = money.computeLine({ unit_price: '19.99', tax_rate: '0', quantity: 2 });
    assert.strictEqual(line.line_total, '39.98');
    assert.strictEqual(line.line_tax, '0.00');
  });

  test('rejects a non-positive or fractional quantity', () => {
    assert.throws(() => money.computeLine({ unit_price: '1.00', tax_rate: '0', quantity: 0 }));
    assert.throws(() => money.computeLine({ unit_price: '1.00', tax_rate: '0', quantity: 1.5 }));
  });
});

describe('money.summarize', () => {
  test('grand_total = subtotal + tax_total to the cent across multiple lines', () => {
    const lines = [
      money.computeLine({ unit_price: '19.99', tax_rate: '7.50', quantity: 3 }), // 59.97 / 4.50
      money.computeLine({ unit_price: '5.00', tax_rate: '18.00', quantity: 2 }), // 10.00 / 1.80
    ];
    const s = money.summarize(lines);
    assert.strictEqual(s.subtotal, '69.97');
    assert.strictEqual(s.tax_total, '6.30');
    assert.strictEqual(s.grand_total, '76.27');
    // invariant
    assert.strictEqual(
      money.toCents(s.grand_total),
      money.toCents(s.subtotal) + money.toCents(s.tax_total)
    );
  });

  test('strips internal cent bookkeeping from the exposed lines', () => {
    const s = money.summarize([
      money.computeLine({ unit_price: '1.00', tax_rate: '0', quantity: 1 }),
    ]);
    assert.ok(!('_lineTotalCents' in s.lines[0]));
    assert.ok(!('_lineTaxCents' in s.lines[0]));
  });

  test('empty cart totals are exact zeros', () => {
    const s = money.summarize([]);
    assert.deepStrictEqual([s.subtotal, s.tax_total, s.grand_total], ['0.00', '0.00', '0.00']);
  });
});

// ── Validators ──────────────────────────────────────────────────────────────

function detailsOf(schema, input) {
  try {
    validateInput(schema, input);
    return null;
  } catch (err) {
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.code, 'VALIDATION_ERROR');
    return err.details;
  }
}

describe('addCartItemSchema', () => {
  test('parses a positive product id and defaults quantity to 1', () => {
    const out = validateInput(addCartItemSchema, { product_id: '12' });
    assert.strictEqual(out.product_id, 12);
    assert.strictEqual(out.quantity, 1);
  });

  test('accepts a numeric string quantity and coerces it to an int', () => {
    const out = validateInput(addCartItemSchema, { product_id: 3, quantity: '4' });
    assert.strictEqual(out.quantity, 4);
  });

  test('rejects quantity < 1, zero, negative and fractional', () => {
    for (const q of [0, -1, 1.5, '2.5']) {
      assert.ok(detailsOf(addCartItemSchema, { product_id: 1, quantity: q }), `qty ${q} must fail`);
    }
  });

  test('rejects a quantity above the documented per-line maximum', () => {
    assert.ok(detailsOf(addCartItemSchema, { product_id: 1, quantity: CART_MAX_LINE_QTY + 1 }));
    // exactly the max is allowed
    assert.ok(
      detailsOf(addCartItemSchema, { product_id: 1, quantity: CART_MAX_LINE_QTY }) === null
    );
  });

  test('rejects a non-positive or non-numeric product id', () => {
    assert.ok(detailsOf(addCartItemSchema, { product_id: 0 }));
    assert.ok(detailsOf(addCartItemSchema, { product_id: -5 }));
    assert.ok(detailsOf(addCartItemSchema, { product_id: 'abc' }));
  });

  test('is strict — a client-supplied owner (customer_id/cart_id/role) is rejected', () => {
    // The authoritative owner is the token subject; these must never be accepted.
    assert.ok(detailsOf(addCartItemSchema, { product_id: 1, quantity: 1, customer_id: 99 }));
    assert.ok(detailsOf(addCartItemSchema, { product_id: 1, quantity: 1, cart_id: 7 }));
    assert.ok(detailsOf(addCartItemSchema, { product_id: 1, quantity: 1, role: 'admin' }));
  });

  test('rejects a missing product id', () => {
    assert.ok(detailsOf(addCartItemSchema, { quantity: 1 }));
  });
});

describe('updateCartItemSchema', () => {
  test('requires an absolute positive quantity', () => {
    assert.strictEqual(validateInput(updateCartItemSchema, { quantity: 5 }).quantity, 5);
    assert.ok(detailsOf(updateCartItemSchema, {})); // missing
    assert.ok(detailsOf(updateCartItemSchema, { quantity: 0 }));
    assert.ok(detailsOf(updateCartItemSchema, { quantity: CART_MAX_LINE_QTY + 1 }));
    assert.ok(detailsOf(updateCartItemSchema, { quantity: 1, product_id: 2 })); // strict
  });
});

describe('cartItemIdParamSchema', () => {
  test('parses a positive integer id and rejects junk', () => {
    assert.strictEqual(validateInput(cartItemIdParamSchema, { itemId: '42' }).itemId, 42);
    assert.ok(detailsOf(cartItemIdParamSchema, { itemId: 'abc' }));
    assert.ok(detailsOf(cartItemIdParamSchema, { itemId: '0' }));
    assert.ok(detailsOf(cartItemIdParamSchema, { itemId: '-3' }));
  });
});
