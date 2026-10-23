/**
 * Invoice status presentation constants (Phase 8).
 *
 * These MIRROR the backend single-source-of-truth
 * (backend/src/constants/invoices.js) purely for display. The UI never enforces
 * anything — the API owns the lifecycle (an invoice is minted `issued` when its
 * order ships; only staff may move it to the terminal `voided`) — so this module
 * is only about what to render, not what is allowed. See docs §2.5 / D-25.
 */

export const INVOICE_STATUS = {
  ISSUED: 'issued',
  VOIDED: 'voided',
};

export const INVOICE_STATUS_VALUES = Object.values(INVOICE_STATUS);

/** Human-readable label for each invoice state. */
export const INVOICE_STATUS_LABELS = {
  issued: 'Issued',
  voided: 'Voided',
};

export function invoiceStatusLabel(status) {
  return INVOICE_STATUS_LABELS[status] || status;
}

/**
 * Only an `issued` invoice can be voided — mirrors the backend `canVoid`. Used
 * to decide whether to offer the staff Void action; the server re-checks and
 * 409s any illegal move regardless.
 */
export function canVoidInvoice(status) {
  return status === INVOICE_STATUS.ISSUED;
}

/**
 * Format a money string for display. Backend returns NUMERIC as strings (integer
 * safe) so we render them verbatim with the ₹ prefix — no float arithmetic here.
 */
export function formatMoney(value) {
  return `₹ ${value}`;
}
