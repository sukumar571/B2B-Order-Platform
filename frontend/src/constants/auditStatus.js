/**
 * Audit presentation constants (Phase 9).
 *
 * These MIRROR the backend single-source-of-truth
 * (backend/src/constants/audit.js) purely for display — the viewer never
 * decides what is auditable (the API writes audit rows only inside business
 * transactions and the table is append-only at the DB level). This module only
 * formats what the ADMIN trail API returns: the outcome pill, the action's
 * human label, and the filter vocabularies offered in the toolbar.
 */

export const AUDIT_OUTCOME = {
  SUCCESS: 'success',
  FAILURE: 'failure',
};

export const AUDIT_OUTCOME_VALUES = Object.values(AUDIT_OUTCOME);

export const AUDIT_OUTCOME_LABELS = {
  success: 'Success',
  failure: 'Failure',
};

export function outcomeLabel(outcome) {
  return AUDIT_OUTCOME_LABELS[outcome] || outcome;
}

/** Entity types the trail can reference — the value is exactly what is stored. */
export const AUDIT_ENTITY_TYPE_VALUES = [
  'user',
  'product',
  'inventory',
  'cart',
  'order',
  'invoice',
];

/**
 * Every action the backend registry can write (kept in sync with
 * backend/src/constants/audit.js). Powers the action filter dropdown; the API
 * validates any value against the same registry.
 */
export const AUDIT_ACTION_VALUES = [
  'USER_REGISTERED',
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'ACCOUNT_DISABLED_ATTEMPT',
  'AUTH_TOKEN_REUSED',
  'USER_ROLE_CHANGED',
  'USER_STATUS_CHANGED',
  'PRODUCT_CREATED',
  'PRODUCT_UPDATED',
  'PRODUCT_ACTIVATED',
  'PRODUCT_DEACTIVATED',
  'STOCK_ADJUSTED',
  'STOCK_RESERVED',
  'STOCK_RELEASED',
  'STOCK_CONSUMED',
  'CART_ITEM_ADDED',
  'CART_ITEM_UPDATED',
  'CART_ITEM_REMOVED',
  'CART_EMPTIED',
  'ORDER_CREATED',
  'ORDER_STATUS_CHANGED',
  'ORDER_CANCELLED',
  'INVOICE_ISSUED',
  'INVOICE_VOIDED',
];

/**
 * Turn a SCREAMING_SNAKE action into a readable SENTENCE-case phrase
 * ('ORDER_STATUS_CHANGED' → 'Order status changed'). The raw code is still shown
 * as the cell's `title` tooltip so an operator can correlate it with the exact
 * registry value.
 */
export function actionLabel(action) {
  if (!action) return '—';
  const sentence = action
    .split('_')
    .map((w) => w.toLowerCase())
    .join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
