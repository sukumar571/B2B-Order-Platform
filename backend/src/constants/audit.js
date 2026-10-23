'use strict';

/**
 * Audit vocabulary (Phase 9 — FR-AUD-01/05, decision D-26).
 *
 * This file is the SINGLE source of truth for which actions and entity types
 * the audit trail recognises. Services must pass an `action` from AUDIT_ACTIONS
 * so the trail stays consistent and the "event matrix" test (audit completeness)
 * can assert every auditable business change emits exactly one row.
 *
 * OUTCOME (migration 18): every row records 'success' or 'failure'. Business
 * mutations are written transactionally — a failed mutation rolls back and
 * leaves NO row — so committed business rows are 'success'. 'failure' is used
 * for security-relevant attempts that are meaningful WITHOUT a data change,
 * principally a rejected login (FR-AUD-01).
 */

const AUDIT_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
});
const AUDIT_OUTCOME_VALUES = Object.freeze(Object.values(AUDIT_OUTCOME));

const AUDIT_ENTITY_TYPE = Object.freeze({
  USER: 'user',
  PRODUCT: 'product',
  INVENTORY: 'inventory',
  CART: 'cart',
  ORDER: 'order',
  INVOICE: 'invoice',
});
const AUDIT_ENTITY_TYPE_VALUES = Object.freeze(Object.values(AUDIT_ENTITY_TYPE));

/**
 * Every action the application writes. Grouped by domain for the docs and the
 * completeness matrix; the values are the literal strings stored in audit_logs.
 */
const AUDIT_ACTIONS = Object.freeze({
  // Authentication & users (Phase 9)
  USER_REGISTERED: 'USER_REGISTERED',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  ACCOUNT_DISABLED_ATTEMPT: 'ACCOUNT_DISABLED_ATTEMPT',
  AUTH_TOKEN_REUSED: 'AUTH_TOKEN_REUSED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_STATUS_CHANGED: 'USER_STATUS_CHANGED',
  // Products (Phase 5; ACTIVATED added in Phase 9)
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_ACTIVATED: 'PRODUCT_ACTIVATED',
  PRODUCT_DEACTIVATED: 'PRODUCT_DEACTIVATED',
  // Inventory & stock (Phase 5; reservation lifecycle audited in Phase 9)
  STOCK_ADJUSTED: 'STOCK_ADJUSTED',
  STOCK_RESERVED: 'STOCK_RESERVED',
  STOCK_RELEASED: 'STOCK_RELEASED',
  STOCK_CONSUMED: 'STOCK_CONSUMED',
  // Cart (Phase 6)
  CART_ITEM_ADDED: 'CART_ITEM_ADDED',
  CART_ITEM_UPDATED: 'CART_ITEM_UPDATED',
  CART_ITEM_REMOVED: 'CART_ITEM_REMOVED',
  CART_EMPTIED: 'CART_EMPTIED',
  // Orders (Phase 7)
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  // Invoices (Phase 8)
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  INVOICE_VOIDED: 'INVOICE_VOIDED',
});

const AUDIT_ACTION_VALUES = Object.freeze(Object.values(AUDIT_ACTIONS));

function isValidAction(action) {
  return AUDIT_ACTION_VALUES.includes(action);
}

function isValidOutcome(outcome) {
  return AUDIT_OUTCOME_VALUES.includes(outcome);
}

module.exports = {
  AUDIT_OUTCOME,
  AUDIT_OUTCOME_VALUES,
  AUDIT_ENTITY_TYPE,
  AUDIT_ENTITY_TYPE_VALUES,
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  isValidAction,
  isValidOutcome,
};
