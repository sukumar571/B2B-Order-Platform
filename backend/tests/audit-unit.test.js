'use strict';

/**
 * Phase 9 — audit unit tests (no database).
 * Covers the action registry (completeness source-of-truth), the outcome
 * validation added to logAudit, and that the constants stay internally
 * consistent. Run under plain `npm test`.
 */

process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  AUDIT_ENTITY_TYPE_VALUES,
  AUDIT_OUTCOME,
  AUDIT_OUTCOME_VALUES,
  isValidAction,
  isValidOutcome,
} = require('../src/constants/audit');
const { logAudit } = require('../src/services/audit.service');

/** A fake client that records the last query + params. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('audit constants registry', () => {
  test('every action value is unique and self-consistent', () => {
    assert.strictEqual(new Set(AUDIT_ACTION_VALUES).size, AUDIT_ACTION_VALUES.length);
    for (const a of AUDIT_ACTION_VALUES) assert.ok(isValidAction(a));
    assert.ok(!isValidAction('NOT_A_REAL_ACTION'));
  });

  test('the Phase 9 additions are all registered', () => {
    for (const a of [
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'USER_REGISTERED',
      'PRODUCT_ACTIVATED',
      'STOCK_RESERVED',
      'STOCK_RELEASED',
      'STOCK_CONSUMED',
      'USER_ROLE_CHANGED',
      'USER_STATUS_CHANGED',
    ]) {
      assert.ok(AUDIT_ACTION_VALUES.includes(a), `${a} must be in the registry`);
    }
  });

  test('outcomes are exactly success|failure', () => {
    assert.deepStrictEqual([...AUDIT_OUTCOME_VALUES].sort(), ['failure', 'success']);
    assert.ok(isValidOutcome(AUDIT_OUTCOME.SUCCESS));
    assert.ok(!isValidOutcome('partial'));
  });

  test('entity types cover the auditable domains', () => {
    for (const t of ['user', 'product', 'inventory', 'order', 'invoice', 'cart']) {
      assert.ok(AUDIT_ENTITY_TYPE_VALUES.includes(t));
    }
  });
});

describe('logAudit outcome behaviour', () => {
  test('defaults outcome to success and binds it as the 7th param', async () => {
    const c = fakeClient();
    await logAudit(c, {
      actorId: 1,
      actorRole: 'admin',
      action: AUDIT_ACTIONS.PRODUCT_CREATED,
      entityType: 'product',
      entityId: 5,
      details: { sku: 'X' },
    });
    const { sql, params } = c.calls[0];
    assert.match(sql, /outcome/);
    assert.strictEqual(params[6], 'success');
  });

  test('records an explicit failure outcome', async () => {
    const c = fakeClient();
    await logAudit(c, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entityType: 'user',
      outcome: AUDIT_OUTCOME.FAILURE,
      details: { reason: 'invalid_credentials' },
    });
    assert.strictEqual(c.calls[0].params[6], 'failure');
    assert.strictEqual(c.calls[0].params[0], null, 'actorId defaults to null');
  });

  test('rejects an outcome outside the domain', async () => {
    const c = fakeClient();
    await assert.rejects(
      () =>
        logAudit(c, {
          action: AUDIT_ACTIONS.LOGIN_SUCCESS,
          entityType: 'user',
          outcome: 'kinda',
        }),
      /invalid outcome/
    );
  });

  test('rejects an action outside the registry (test-mode completeness guard)', async () => {
    const c = fakeClient();
    await assert.rejects(
      () => logAudit(c, { action: 'SOMETHING_NEW', entityType: 'user' }),
      /unregistered action/
    );
  });

  test('rejects a malformed action string and a missing entityType', async () => {
    const c = fakeClient();
    await assert.rejects(
      () => logAudit(c, { action: 'lower', entityType: 'user' }),
      /invalid action/
    );
    await assert.rejects(() => logAudit(c, { action: AUDIT_ACTIONS.LOGIN_SUCCESS }), /entityType/);
  });
});
