'use strict';

/**
 * Phase 8 — invoice unit tests (no database). Covers the numbering/format
 * helpers, the status transition predicate, and the strict Zod invoice schemas
 * (which must reject any attempt to inject totals or ownership). The HTTP +
 * PostgreSQL behaviour (atomic generation on ship, uniqueness, scoping) lives in
 * invoice-http.test.js (integration).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  INVOICE_STATUS,
  INVOICE_STATUS_VALUES,
  INVOICE_NUMBER_RE,
  canVoid,
  formatInvoiceNumber,
  counterPeriodForYear,
  INVOICE_DEMO_NOTICE,
  DISTRIBUTOR,
} = require('../src/constants/invoices');
const {
  invoiceListQuerySchema,
  invoiceIdParamSchema,
  voidInvoiceSchema,
  validateInput,
} = require('../src/utils/validators');

describe('Invoice numbering + status helpers (FR-INV-02 / D-25)', () => {
  test('formatInvoiceNumber produces INV-YYYY-NNNNNN zero-padded to 6 digits', () => {
    assert.strictEqual(formatInvoiceNumber(2026, 1), 'INV-2026-000001');
    assert.strictEqual(formatInvoiceNumber(2026, 42), 'INV-2026-000042');
    assert.strictEqual(formatInvoiceNumber(2026, 123456), 'INV-2026-123456');
    assert.match(formatInvoiceNumber(2026, 7), INVOICE_NUMBER_RE);
  });

  test('counterPeriodForYear keys the sequence by calendar year', () => {
    assert.strictEqual(counterPeriodForYear(2026), '2026');
    assert.strictEqual(counterPeriodForYear('2030'), '2030');
  });

  test('only an issued invoice can be voided; voided is terminal', () => {
    assert.strictEqual(canVoid(INVOICE_STATUS.ISSUED), true);
    assert.strictEqual(canVoid(INVOICE_STATUS.VOIDED), false);
    assert.deepStrictEqual(INVOICE_STATUS_VALUES, ['issued', 'voided']);
  });

  test('a demo notice + distributor block are always present (simulated business)', () => {
    assert.match(INVOICE_DEMO_NOTICE, /DEMONSTRATION DOCUMENT/i);
    assert.match(INVOICE_DEMO_NOTICE, /not a legal tax invoice/i);
    assert.ok(DISTRIBUTOR.name && DISTRIBUTOR.address_lines.length >= 1);
  });
});

describe('Invoice Zod schemas are strict and tamper-proof (FR-INV-04)', () => {
  test('invoiceListQuerySchema defaults paging and validates the status enum', () => {
    const q = validateInput(invoiceListQuerySchema, {});
    assert.strictEqual(q.page, 1);
    assert.strictEqual(q.limit, 20);
    assert.strictEqual(
      validateInput(invoiceListQuerySchema, { status: 'issued' }).status,
      'issued'
    );
    assert.strictEqual(
      validateInput(invoiceListQuerySchema, { status: 'voided' }).status,
      'voided'
    );
    // A payment state does not exist (settlement is out of scope).
    assert.throws(() => validateInput(invoiceListQuerySchema, { status: 'paid' }));
    assert.throws(() => validateInput(invoiceListQuerySchema, { unknown: 'x' }));
  });

  test('invoiceIdParamSchema accepts positive ints and rejects junk / unknown keys', () => {
    assert.strictEqual(validateInput(invoiceIdParamSchema, { id: '5' }).id, 5);
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      assert.throws(() => validateInput(invoiceIdParamSchema, { id: bad }), `reject id=${bad}`);
    }
    assert.throws(() => validateInput(invoiceIdParamSchema, { id: 5, extra: 1 }));
  });

  test('voidInvoiceSchema requires a 3–500 char reason and rejects injected money', () => {
    assert.strictEqual(
      validateInput(voidInvoiceSchema, { reason: 'goods returned' }).reason,
      'goods returned'
    );
    assert.throws(() => validateInput(voidInvoiceSchema, { reason: 'x' })); // too short
    assert.throws(() => validateInput(voidInvoiceSchema, {})); // missing
    // A client can NEVER alter totals or ownership through the void body.
    assert.throws(() => validateInput(voidInvoiceSchema, { reason: 'ok', grand_total: '0.01' }));
    assert.throws(() => validateInput(voidInvoiceSchema, { reason: 'ok', customer_id: '99' }));
  });
});
