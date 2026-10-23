'use strict';

/**
 * Phase 5 — pure unit tests for the catalog/inventory input validators.
 * These need no database: they pin down the Zod contracts (SKU uniqueness
 * inputs, price/tax bounds, non-blank name, pagination clamp, sort whitelist,
 * strict rejection of unknown/privileged fields, stock-delta rules) before the
 * HTTP + DB integration suite exercises them end to end.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  validateInput,
  productListQuerySchema,
  inventoryListQuerySchema,
  productIdParamSchema,
  createProductSchema,
  updateProductSchema,
  updateInventorySchema,
  SORTABLE_PRODUCT_COLUMNS,
} = require('../src/utils/validators');

/** Return the field->message map validateInput throws for an invalid payload,
 *  or null when the payload is valid. */
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

const VALID_PRODUCT = { sku: 'TEST-1', name: 'Test Widget', unit_price: '19.99' };

describe('createProductSchema', () => {
  test('applies safe defaults and normalizes money', () => {
    const out = validateInput(createProductSchema, VALID_PRODUCT);
    assert.strictEqual(out.description, '');
    assert.strictEqual(out.tax_rate, '0');
    assert.strictEqual(out.initial_stock, 0);
    assert.strictEqual(out.low_stock_threshold, 20);
    assert.strictEqual(out.is_active, true);
    assert.strictEqual(out.unit_price, '19.99');
  });

  test('accepts a JSON number price and trims strings', () => {
    const out = validateInput(createProductSchema, {
      sku: '  X 2 ',
      name: ' Padded ',
      unit_price: 20,
    });
    assert.strictEqual(out.sku, 'X 2');
    assert.strictEqual(out.name, 'Padded');
    assert.strictEqual(out.unit_price, '20');
  });

  test('rejects blank name, blank sku, negative/zero price and >2-decimal price', () => {
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, name: '   ' }).name);
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, sku: '' }).sku);
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, unit_price: '-5' }).unit_price);
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, unit_price: '0' }).unit_price);
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, unit_price: '1.999' }).unit_price);
  });

  test('rejects tax_rate outside 0..100', () => {
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, tax_rate: '101' }).tax_rate);
    assert.ok(detailsOf(createProductSchema, { ...VALID_PRODUCT, tax_rate: '-1' }).tax_rate);
  });

  test('rejects negative initial_stock / threshold', () => {
    assert.ok(
      detailsOf(createProductSchema, { ...VALID_PRODUCT, initial_stock: -1 }).initial_stock
    );
    assert.ok(
      detailsOf(createProductSchema, { ...VALID_PRODUCT, low_stock_threshold: -3 })
        .low_stock_threshold
    );
  });

  test('STRICT: unknown fields (e.g. role, is_admin) are rejected', () => {
    // Zod reports unrecognized keys under the root path ("_") — the payload
    // fails closed regardless of which field name an attacker invents.
    const d = detailsOf(createProductSchema, { ...VALID_PRODUCT, role: 'admin' });
    assert.ok(d && Object.keys(d).length > 0);
    assert.match(JSON.stringify(d), /role/);
    const d2 = detailsOf(createProductSchema, { ...VALID_PRODUCT, sneaky: 1 });
    assert.ok(d2 && Object.keys(d2).length > 0);
  });
});

describe('updateProductSchema', () => {
  test('a single field patch is valid', () => {
    assert.deepStrictEqual(validateInput(updateProductSchema, { is_active: false }), {
      is_active: false,
    });
  });

  test('an empty patch fails (nothing to update)', () => {
    assert.ok(detailsOf(updateProductSchema, {}));
  });

  test('STRICT: unknown fields rejected', () => {
    const d = detailsOf(updateProductSchema, { unit_price: '5.00', role: 'admin' });
    assert.ok(d && Object.keys(d).length > 0);
    assert.match(JSON.stringify(d), /role/);
  });

  test('booleans coerce from string query-ish values', () => {
    assert.strictEqual(validateInput(updateProductSchema, { is_active: 'false' }).is_active, false);
    assert.strictEqual(validateInput(updateProductSchema, { is_active: 'true' }).is_active, true);
  });
});

describe('productListQuerySchema', () => {
  test('defaults', () => {
    const q = validateInput(productListQuerySchema, {});
    assert.strictEqual(q.sort, 'name');
    assert.strictEqual(q.order, 'asc');
    assert.strictEqual(q.active_only, true);
    assert.strictEqual(q.page, 1);
    assert.strictEqual(q.limit, 20);
    assert.strictEqual(q.search, undefined);
  });

  test('coerces numeric + boolish query-string params', () => {
    const q = validateInput(productListQuerySchema, {
      search: '  widget  ',
      sort: 'price',
      order: 'desc',
      active_only: 'false',
      page: '3',
      limit: '50',
    });
    assert.strictEqual(q.search, 'widget');
    assert.strictEqual(q.sort, 'price');
    assert.strictEqual(q.order, 'desc');
    assert.strictEqual(q.active_only, false);
    assert.strictEqual(q.page, 3);
    assert.strictEqual(q.limit, 50);
  });

  test('invalid sort column, order, and out-of-range pagination fail closed', () => {
    assert.ok(detailsOf(productListQuerySchema, { sort: 'DROP TABLE' }).sort);
    assert.ok(detailsOf(productListQuerySchema, { order: 'sideways' }).order);
    assert.ok(detailsOf(productListQuerySchema, { limit: '999' }).limit);
    assert.ok(detailsOf(productListQuerySchema, { page: '0' }).page);
    assert.ok(detailsOf(productListQuerySchema, { page: 'abc' }).page);
  });

  test('sort keys stay aligned with the repository whitelist', () => {
    assert.deepStrictEqual(
      Object.keys(SORTABLE_PRODUCT_COLUMNS).sort(),
      ['available', 'created_at', 'name', 'price', 'sku'].sort()
    );
  });
});

describe('productIdParamSchema', () => {
  test('parses a positive integer id', () => {
    assert.deepStrictEqual(validateInput(productIdParamSchema, { id: '42' }), { id: 42 });
  });
  test('rejects non-numeric / zero / negative ids', () => {
    assert.ok(detailsOf(productIdParamSchema, { id: 'abc' }).id);
    assert.ok(detailsOf(productIdParamSchema, { id: '0' }).id);
    assert.ok(detailsOf(productIdParamSchema, { id: '-3' }).id);
  });
});

describe('inventoryListQuerySchema', () => {
  test('defaults (staff view shows both active + inactive, all stock)', () => {
    const q = validateInput(inventoryListQuerySchema, {});
    assert.strictEqual(q.active_only, false);
    assert.strictEqual(q.low_stock_only, false);
    assert.strictEqual(q.page, 1);
    assert.strictEqual(q.limit, 20);
  });
});

describe('updateInventorySchema', () => {
  test('valid signed delta + reason', () => {
    const out = validateInput(updateInventorySchema, { delta: '-20', reason: 'damaged' });
    assert.strictEqual(out.delta, -20);
    assert.strictEqual(out.reason, 'damaged');
  });
  test('zero delta rejected', () => {
    assert.ok(detailsOf(updateInventorySchema, { delta: 0, reason: 'x' }).delta);
  });
  test('non-integer delta rejected', () => {
    assert.ok(detailsOf(updateInventorySchema, { delta: 2.5, reason: 'x' }).delta);
  });
  test('missing/blank reason rejected', () => {
    assert.ok(detailsOf(updateInventorySchema, { delta: 5 }).reason);
    assert.ok(detailsOf(updateInventorySchema, { delta: 5, reason: '   ' }).reason);
  });
  test('STRICT: unknown fields rejected', () => {
    const d = detailsOf(updateInventorySchema, { delta: 5, reason: 'ok', surprise: 1 });
    assert.ok(d && Object.keys(d).length > 0);
    assert.match(JSON.stringify(d), /surprise/);
  });
});
