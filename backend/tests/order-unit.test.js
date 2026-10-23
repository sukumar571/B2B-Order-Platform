'use strict';

/**
 * Phase 7 — order unit tests (no database). Covers the transition matrix, the
 * idempotency fingerprint/merge helpers, and the strict Zod order schemas. The
 * HTTP + PostgreSQL behaviour (atomicity, concurrency, replay) lives in
 * order-http.test.js (integration).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ORDER_STATUS,
  FORWARD_TRANSITIONS,
  CANCELLABLE_STATUSES,
  CONSUMPTION_STATUS,
  isLegalForward,
  isCancellable,
} = require('../src/constants/orders');
const { mergeLines, fingerprint } = require('../src/services/order.service');
const {
  createOrderSchema,
  updateOrderStatusSchema,
  cancelOrderSchema,
  orderListQuerySchema,
  validateInput,
} = require('../src/utils/validators');

describe('Order lifecycle matrix (FR-ORD-07)', () => {
  test('forward edges are exactly the one-step chain', () => {
    assert.ok(isLegalForward('pending', 'confirmed'));
    assert.ok(isLegalForward('confirmed', 'processing'));
    assert.ok(isLegalForward('processing', 'shipped'));
    assert.ok(isLegalForward('shipped', 'delivered'));
  });

  test('no skipping, no backwards, terminals have no outgoing edge', () => {
    assert.ok(!isLegalForward('pending', 'shipped'), 'cannot skip processing');
    assert.ok(!isLegalForward('pending', 'delivered'));
    assert.ok(!isLegalForward('processing', 'pending'), 'cannot go backwards');
    assert.ok(!isLegalForward('delivered', 'pending'), 'delivered is terminal');
    assert.ok(!isLegalForward('cancelled', 'pending'), 'cancelled is terminal');
    assert.deepStrictEqual(FORWARD_TRANSITIONS[ORDER_STATUS.DELIVERED], []);
    assert.deepStrictEqual(FORWARD_TRANSITIONS[ORDER_STATUS.CANCELLED], []);
  });

  test('cancellation is only legal pre-shipment (pending/confirmed)', () => {
    assert.ok(isCancellable('pending'));
    assert.ok(isCancellable('confirmed'));
    assert.ok(!isCancellable('processing'));
    assert.ok(!isCancellable('shipped'), 'stock already consumed at shipment — cannot cancel');
    assert.ok(!isCancellable('delivered'));
    assert.deepStrictEqual(CANCELLABLE_STATUSES, ['pending', 'confirmed']);
    assert.strictEqual(CONSUMPTION_STATUS, 'shipped', 'reservation is consumed exactly at shipped');
  });
});

describe('Order request normalization (idempotency matching)', () => {
  test('mergeLines sums duplicate product ids and sorts by id', () => {
    const merged = mergeLines([
      { product_id: '3', quantity: 2 },
      { product_id: 1, quantity: 1 },
      { product_id: '3', quantity: 5 },
    ]);
    assert.deepStrictEqual(merged, [
      { product_id: 1, quantity: 1 },
      { product_id: 3, quantity: 7 },
    ]);
  });

  test('fingerprint is order-independent and stable', () => {
    const a = fingerprint([
      { product_id: 2, quantity: 1 },
      { product_id: 1, quantity: 3 },
    ]);
    const b = fingerprint([
      { product_id: '1', quantity: '3' },
      { product_id: '2', quantity: '1' },
    ]);
    assert.strictEqual(a, b, 'same set of lines hashes identically regardless of order/types');
    const different = fingerprint([{ product_id: 1, quantity: 4 }]);
    assert.notStrictEqual(a, different);
  });
});

describe('Order Zod schemas are strict and price-agnostic', () => {
  test('createOrderSchema accepts items[] and an empty body (cart order)', () => {
    assert.deepStrictEqual(createOrderSchema.parse({}), {});
    const withItems = createOrderSchema.parse({ items: [{ product_id: 5, quantity: 2 }] });
    assert.strictEqual(withItems.items[0].product_id, 5);
  });

  test('createOrderSchema rejects client prices, ids <= 0, bad quantities and unknown fields', () => {
    assert.throws(
      () => createOrderSchema.parse({ unit_price: '1.00' }),
      (e) => e.name === 'ZodError'
    );
    assert.throws(
      () => createOrderSchema.parse({ items: [{ product_id: 5, quantity: 0 }] }),
      (e) => e.name === 'ZodError'
    );
    assert.throws(
      () => createOrderSchema.parse({ items: [{ product_id: 0, quantity: 1 }] }),
      (e) => e.name === 'ZodError'
    );
    assert.throws(
      () => createOrderSchema.parse({ items: [{ product_id: 1, quantity: 1, total: '9' }] }),
      (e) => e.name === 'ZodError'
    );
  });

  test('updateOrderStatusSchema accepts lifecycle values only', () => {
    assert.deepStrictEqual(updateOrderStatusSchema.parse({ status: 'confirmed' }), {
      status: 'confirmed',
    });
    // 'fulfilled' is retired; an unknown value fails closed with 400 via validateInput.
    assert.throws(
      () => validateInput(updateOrderStatusSchema, { status: 'fulfilled' }),
      (e) => e.status === 400
    );
    assert.throws(
      () => validateInput(updateOrderStatusSchema, {}),
      (e) => e.status === 400
    );
  });

  test('cancelOrderSchema requires a meaningful reason', () => {
    assert.strictEqual(
      cancelOrderSchema.parse({ reason: 'changed my mind' }).reason,
      'changed my mind'
    );
    assert.throws(
      () => validateInput(cancelOrderSchema, { reason: 'ab' }),
      (e) => e.status === 400
    );
    assert.throws(
      () => validateInput(cancelOrderSchema, {}),
      (e) => e.status === 400
    );
    assert.throws(
      () => validateInput(cancelOrderSchema, { reason: 'ok', extra: 1 }),
      (e) => e.status === 400
    );
  });

  test('orderListQuerySchema defaults paging and validates status enum', () => {
    const parsed = orderListQuerySchema.parse({});
    assert.strictEqual(parsed.page, 1);
    assert.strictEqual(parsed.limit, 20);
    assert.strictEqual(orderListQuerySchema.parse({ status: 'pending' }).status, 'pending');
    assert.throws(
      () => validateInput(orderListQuerySchema, { status: 'nope' }),
      (e) => e.status === 400
    );
    assert.throws(
      () => validateInput(orderListQuerySchema, { limit: 999 }),
      (e) => e.status === 400
    );
  });
});
