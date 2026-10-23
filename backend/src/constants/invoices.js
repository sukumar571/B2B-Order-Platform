'use strict';

/**
 * Invoice vocabulary + numbering (Phase 8 — FR-INV-01..05, decision D-25).
 *
 * LIFECYCLE (docs/api-specification.md §2.5):
 *
 *   issued ──► voided        (voided is terminal)
 *
 * - An invoice is created `issued` atomically when its order reaches `shipped`
 *   (the fulfillment point where stock is consumed — D-24). The line items and
 *   totals are copied from the ORDER's persisted snapshot, never recomputed from
 *   the live catalog (D-07 / AC-INV-01), so a later price/name edit cannot alter
 *   an already-issued invoice (SC-04).
 * - `voided` is a staff-only annulment (a credit/reversal for this simulated
 *   book). Voiding PRESERVES the row and its denormalized totals — it never
 *   deletes financial history (financial-record immutability). An order can only
 *   be cancelled PRE-shipment (Phase 7), i.e. before any invoice exists, so
 *   cancellation never voids anything: a cancelled order simply has no invoice.
 * - Payment/settlement is OUT OF SCOPE (requirements §3.2 / D-14): "invoices
 *   record amounts only", hence there is deliberately NO `paid`/`overdue` state.
 *
 * NUMBERING (FR-INV-02 / D-10): `INV-YYYY-NNNNNN`. The sequence is drawn from a
 * per-CALENDAR-YEAR counter row (invoice_counters.period = 'YYYY') via an
 * atomic upsert-RETURNING inside the shipping transaction, so it is race-safe
 * and gap-tolerant and the 6-digit part increases strictly within a year — which
 * is what keeps UNIQUE(invoice_number) guaranteed for a year-only number.
 */

const INVOICE_STATUS = {
  ISSUED: 'issued',
  VOIDED: 'voided',
};

const INVOICE_STATUS_VALUES = Object.freeze(Object.values(INVOICE_STATUS));

/** The only legal status move: an issued invoice may be voided (voided is terminal). */
function canVoid(status) {
  return status === INVOICE_STATUS.ISSUED;
}

/**
 * `INV-YYYY-NNNNNN`. `year` is a 4-digit number, `seq` a positive integer padded
 * to 6 digits (the DB CHECK `^INV-[0-9]{4}-[0-9]{6}$` is the last-line guard).
 */
const INVOICE_NUMBER_RE = /^INV-\d{4}-\d{6}$/;

function formatInvoiceNumber(year, seq) {
  return `INV-${String(year)}-${String(seq).padStart(6, '0')}`;
}

/** The counter period key for a yearly sequence (matches INV-YYYY-NNNNNN). */
function counterPeriodForYear(year) {
  return String(year);
}

// ── Demonstration document framing (this is a SIMULATED business, D-25) ──────
// The platform is not connected to any tax authority or accounting system, so a
// real fiscal invoice cannot be claimed. These are surfaced on the printable
// view and in the API payload so every rendered invoice is explicitly labelled.
const INVOICE_DEMO_NOTICE =
  'DEMONSTRATION DOCUMENT — this is a simulated business. It is NOT a legal tax ' +
  'invoice and no real tax compliance has been established.';

// A single-tenant demo distributor (A-01). Placeholder details only; NOT a real
// registered business address or tax registration.
const DISTRIBUTOR = Object.freeze({
  name: 'B2B OMS Demo Distributor',
  tagline: 'Wholesale Distribution — Demonstration Instance',
  address_lines: ['1 Example Way', 'Demo City, DC 00000'],
  contact: 'billing@b2boms.test',
  tax_registration: 'N/A — simulation, no tax registration',
});

module.exports = {
  INVOICE_STATUS,
  INVOICE_STATUS_VALUES,
  INVOICE_NUMBER_RE,
  canVoid,
  formatInvoiceNumber,
  counterPeriodForYear,
  INVOICE_DEMO_NOTICE,
  DISTRIBUTOR,
};
