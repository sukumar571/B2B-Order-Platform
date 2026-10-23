'use strict';

/**
 * 17 — Phase 8 invoice status + void fields + yearly numbering
 *
 * (a) Adds `invoices.status` — an invoice is `issued` when the order ships and
 *       may be `voided` by staff (a credit/reversal for this simulated book).
 *       NOT NULL DEFAULT 'issued' so the raw INSERTs that predate Phase 8 stay
 *       valid. Cancellation never voids anything because an order can only be
 *       cancelled PRE-shipment (Phase 7), i.e. before any invoice exists — so
 *       the ONLY status move is issued → voided (constants/invoices.js owns it).
 *       `void_reason` / `voided_at` record the annulment WITHOUT deleting the
 *       row or its denormalized totals (financial-record immutability, D-07).
 *
 * (b) Broadens `invoice_counter_period_format` so a counter row can be keyed by
 *       a calendar YEAR ('2026') in addition to the existing 'YYYY-MM'. Invoice
 *       numbers are INV-YYYY-NNNNNN (year only), so the sequence MUST be per
 *       year for the UNIQUE(invoice_number) to hold — a monthly counter under a
 *       year-only number could emit INV-2026-000001 twice (Jan and Feb). The
 *       service now draws from the yearly row; the pre-existing monthly periods
 *       stay valid under the relaxed CHECK (nothing is rewritten).
 *
 * Fully reversible: the down script drops the columns and restores the original
 * strict monthly CHECK. The reversibility test empties `invoice_counters` first
 * so any yearly rows cannot violate the re-added monthly CHECK on the way down.
 */

const NEW_PERIOD = `^[0-9]{4}(-[0-9]{2})?$`; // 'YYYY' or 'YYYY-MM'
const OLD_PERIOD = `^[0-9]{4}-[0-9]{2}$`; // 'YYYY-MM' only (pre-Phase-8)

exports.up = (pgm) => {
  pgm.addColumn('invoices', {
    status: { type: 'varchar(16)', notNull: true, default: pgm.func("'issued'") },
    void_reason: { type: 'varchar(500)' },
    voided_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('invoices', 'invoice_status_valid', {
    check: `status IN ('issued', 'voided')`,
  });

  pgm.dropConstraint('invoice_counters', 'invoice_counter_period_format', { ifExists: true });
  pgm.addConstraint('invoice_counters', 'invoice_counter_period_format', {
    check: `period ~ '${NEW_PERIOD}'`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('invoice_counters', 'invoice_counter_period_format', { ifExists: true });
  pgm.addConstraint('invoice_counters', 'invoice_counter_period_format', {
    check: `period ~ '${OLD_PERIOD}'`,
  });

  pgm.dropConstraint('invoices', 'invoice_status_valid', { ifExists: true });
  pgm.dropColumns('invoices', ['status', 'void_reason', 'voided_at'], { ifExists: true });
};
