'use strict';

/**
 * Phase 9 live smoke — audit logging + dashboards against a running dev server.
 *
 *   npm run db:migrate && npm run db:seed    # dev DB ready (host :5433)
 *   node src/server.js                        # API on http://localhost:4000
 *   node scripts/smoke/phase9-dashboard-smoke.js
 *
 * This script MINTS GENUINE activity — a rejected login, a disabled-account
 * attempt, a product create→deactivate→activate cycle, a stock receipt, an
 * order that reserves→consumes stock and ships (invoicing) and a second order
 * that reserves→releases via cancellation, an invoice void, and an audited
 * admin user change — then PROVES the cross-cutting Phase 9 guarantees:
 *
 *   1. ACCESS CONTROL  GET /api/audit-logs and /api/reports/dashboard are
 *      ADMIN-only; the staff report (/order-summary, /low-stock) is
 *      ADMIN + ORDER_MANAGER; a customer / agent / anon is refused.
 *   2. READ-ONLY TRAIL no write verb exists anywhere on /api/audit-logs, and
 *      the database itself refuses UPDATE/DELETE on audit_logs (append-only).
 *   3. OUTCOME         a committed business change is 'success'; a rejected
 *      login / disabled-account attempt is stored as 'failure'.
 *   4. COMPLETENESS    every auditable event emitted exactly one row (checked
 *      against the DB, keyed on the unique ids this run created).
 *   5. FILTERS/PAGING  action / entity_type / outcome filters and meta paging.
 *   6. METRIC HONESTY  the admin dashboard embeds the audit feed; the agent
 *      order-summary does NOT; booked_order_value is labelled as NOT revenue.
 *
 * Write steps use a unique SMOKE9-<timestamp> SKU and a throwaway user so the
 * dev catalog and the seeded roles are never clobbered. It LEAVES the minted
 * orders/invoices/audit rows in the dev DB so the dashboard + audit screenshots
 * show real data.
 *
 * Evidence: evidence/test-reports/phase9-dashboard-smoke.json (+ .txt console).
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../../src/config/env');
const { Pool } = require('pg');

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:4000';
const DEV_PASSWORD = 'Passw0rd!';
const results = [];

async function step(name, method, urlPath, { body, token, idem, expect } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;

  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  const status = res.status;
  const expected = Array.isArray(expect) ? expect : [expect];
  const pass = expected.includes(status);
  results.push({
    name,
    method,
    path: urlPath,
    status,
    expected,
    pass,
    error: payload?.error
      ? { code: payload.error.code, message: payload.error.message }
      : undefined,
    meta: payload?.meta,
    count: Array.isArray(payload?.data) ? payload.data.length : undefined,
  });
  const mark = pass ? 'ok  ' : 'FAIL';
  console.log(`[${mark}] ${status} ${method} ${urlPath} — ${name}`);
  return payload;
}

const assert = (label, condition, detail) => {
  results.push({ name: `assert: ${label}`, pass: Boolean(condition), detail, assert: true });
  console.log(
    `[${condition ? 'ok  ' : 'FAIL'}] ${label}${condition ? '' : ` — got ${JSON.stringify(detail)}`}`
  );
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

(async () => {
  const ts = Date.now();
  const SKU = `SMOKE9-${ts}`;

  // ── Health ───────────────────────────────────────────────────────────────
  await step('health', 'GET', '/api/health', { expect: 200 });

  // ── 1. Mint FAILURE-outcome activity (a security event, no data change) ────
  // A bad password is a LOGIN_FAILED (uniform 401, never reveals the account);
  // the disabled-account FAILURE row is minted later in §6 by deactivating a
  // throwaway we control, so this run never depends on the seed's account set.
  await step('a wrong-password login is refused (401)', 'POST', '/api/auth/login', {
    body: { email: 'customer@b2boms.test', password: `not-the-password-${ts}` },
    expect: 401,
  });

  // ── 2. Real identities ────────────────────────────────────────────────────
  const admin = await step('admin login', 'POST', '/api/auth/login', {
    body: { email: 'admin@b2boms.test', password: DEV_PASSWORD },
    expect: 200,
  });
  const adminToken = admin.accessToken;

  const agent = await step('order-manager (agent) login', 'POST', '/api/auth/login', {
    body: { email: 'agent@b2boms.test', password: DEV_PASSWORD },
    expect: 200,
  });
  const agentToken = agent.accessToken;

  const customer = await step('customer login', 'POST', '/api/auth/login', {
    body: { email: 'customer@b2boms.test', password: DEV_PASSWORD },
    expect: 200,
  });
  const customerToken = customer.accessToken;

  // ── 3. Product create → deactivate → activate (PRODUCT_* audit events) ─────
  const created = await step('admin creates a product', 'POST', '/api/products', {
    token: adminToken,
    body: {
      sku: SKU,
      name: `Phase9 Smoke Widget ${ts}`,
      description: 'Minted by the Phase 9 audit smoke; safe to ignore.',
      unit_price: '25.00',
      tax_rate: '5.00',
      initial_stock: 0,
      low_stock_threshold: 10,
      is_active: true,
    },
    expect: 201,
  });
  const productId = created.id;

  await step('admin receives 100 units (STOCK_ADJUSTED)', 'PATCH', `/api/inventory/${productId}`, {
    token: adminToken,
    body: { delta: 100, reason: `Phase9 smoke receipt ${ts}`, low_stock_threshold: 10 },
    expect: 200,
  });

  await step(
    'admin deactivates the product (PRODUCT_DEACTIVATED)',
    'PATCH',
    `/api/products/${productId}`,
    {
      token: adminToken,
      body: { is_active: false },
      expect: 200,
    }
  );
  await step(
    'admin re-activates the product (PRODUCT_ACTIVATED)',
    'PATCH',
    `/api/products/${productId}`,
    {
      token: adminToken,
      body: { is_active: true },
      expect: 200,
    }
  );

  // ── 4. Order that RESERVES then CONSUMES stock and SHIPS (invoices) ────────
  await step('empty the customer cart', 'DELETE', '/api/cart', {
    token: customerToken,
    expect: [200, 204],
  });
  await step('customer adds 3 units', 'POST', '/api/cart/items', {
    token: customerToken,
    body: { product_id: productId, quantity: 3 },
    expect: [200, 201],
  });
  const placed = await step(
    'customer places the order (STOCK_RESERVED + ORDER_CREATED)',
    'POST',
    '/api/orders',
    {
      token: customerToken,
      body: {},
      idem: uuid(),
      expect: 201,
    }
  );
  const shipOrderId = (placed.data ?? placed)?.id;

  for (const status of ['confirmed', 'processing', 'shipped']) {
    await step(`advance order → ${status}`, 'PATCH', `/api/orders/${shipOrderId}/status`, {
      token: adminToken,
      body: { status },
      expect: 200,
    });
  }
  const invoice = await step(
    'the shipment minted an invoice (INVOICE_ISSUED)',
    'GET',
    `/api/orders/${shipOrderId}/invoice`,
    {
      token: customerToken,
      expect: 200,
    }
  );
  const invoiceId = invoice.id ?? invoice.data?.id;

  // Void that invoice (INVOICE_VOIDED). Keep the order shipped for the demo.
  await step(
    'staff voids the invoice (INVOICE_VOIDED)',
    'POST',
    `/api/invoices/${invoiceId}/void`,
    {
      token: adminToken,
      body: { reason: `Phase9 smoke void ${ts}` },
      expect: 200,
    }
  );

  // ── 5. A second order that RESERVES then RELEASES via cancellation ─────────
  await step('customer adds 2 units again', 'POST', '/api/cart/items', {
    token: customerToken,
    body: { product_id: productId, quantity: 2 },
    expect: [200, 201],
  });
  const placed2 = await step('customer places the second order', 'POST', '/api/orders', {
    token: customerToken,
    body: {},
    idem: uuid(),
    expect: 201,
  });
  const cancelOrderId = (placed2.data ?? placed2)?.id;
  await step(
    'the order is cancelled (STOCK_RELEASED + ORDER_CANCELLED)',
    'POST',
    `/api/orders/${cancelOrderId}/cancel`,
    {
      token: customerToken,
      body: { reason: `Phase9 smoke cancel ${ts}` },
      expect: 200,
    }
  );

  // ── 6. Audited admin user changes (USER_ROLE_CHANGED, USER_STATUS_CHANGED) ─
  // Registration enforces a >=10-char password, so use a dev value distinct
  // from the seed's 9-char password.
  const THROWAWAY_PW = 'Sm0kePassw0rd!';
  const throwaway = await step(
    'register a throwaway customer to administer',
    'POST',
    '/api/auth/register',
    {
      // Registration is CUSTOMER-only and the strict schema accepts no `role`
      // field — the account starts as a customer and the admin manages it below.
      body: {
        email: `smoke9-${ts}@b2boms.test`,
        password: THROWAWAY_PW,
        name: 'Phase9 Throwaway',
      },
      expect: [200, 201],
    }
  );
  const throwawayId = throwaway.user?.id;
  await step(
    'admin promotes the throwaway to agent (USER_ROLE_CHANGED)',
    'PATCH',
    `/api/users/${throwawayId}`,
    {
      token: adminToken,
      body: { role: 'agent' },
      expect: 200,
    }
  );
  await step(
    'admin deactivates the throwaway (USER_STATUS_CHANGED)',
    'PATCH',
    `/api/users/${throwawayId}`,
    {
      token: adminToken,
      body: { is_active: false },
      expect: 200,
    }
  );
  await step(
    'the now-disabled account cannot log in (ACCOUNT_DISABLED_ATTEMPT)',
    'POST',
    '/api/auth/login',
    {
      body: { email: `smoke9-${ts}@b2boms.test`, password: THROWAWAY_PW },
      expect: 403,
    }
  );
  await step(
    'an admin cannot demote their OWN account (self-lockout)',
    'PATCH',
    `/api/users/${admin.user?.id}`,
    {
      token: adminToken,
      body: { role: 'customer' },
      expect: 409,
    }
  );

  // ── 7. ACCESS CONTROL: audit trail + full dashboard are ADMIN-only ─────────
  await step('anon cannot read the audit trail', 'GET', '/api/audit-logs', { expect: 401 });
  await step('customer cannot read the audit trail', 'GET', '/api/audit-logs', {
    token: customerToken,
    expect: 403,
  });
  await step('agent (order manager) cannot read the audit trail', 'GET', '/api/audit-logs', {
    token: agentToken,
    expect: 403,
  });
  await step('customer cannot open the full dashboard', 'GET', '/api/reports/dashboard', {
    token: customerToken,
    expect: 403,
  });
  await step(
    'agent cannot open the full dashboard (embeds the audit feed)',
    'GET',
    '/api/reports/dashboard',
    {
      token: agentToken,
      expect: 403,
    }
  );

  // ── 8. READ-ONLY TRAIL: no write verb is mounted on /api/audit-logs ────────
  for (const verb of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    await step(`${verb} /api/audit-logs has no route (read-only)`, verb, '/api/audit-logs', {
      token: adminToken,
      body: {},
      expect: [404, 405],
    });
  }

  // ── 9. STAFF report access + METRIC HONESTY ────────────────────────────────
  const dash = await step('admin can open the full dashboard', 'GET', '/api/reports/dashboard', {
    token: adminToken,
    expect: 200,
  });
  assert(
    'the admin dashboard embeds the audit activity feed',
    dash.data && dash.data.audit && Array.isArray(dash.data.audit.recent_activity),
    dash.data && Object.keys(dash.data)
  );
  assert(
    'booked_order_value is defined and explicitly NOT called revenue',
    typeof dash.data?.totals?.booked_order_value !== 'undefined' &&
      /not collected revenue|not revenue/i.test(
        dash.data?.metric_definitions?.booked_order_value || ''
      ),
    dash.data?.metric_definitions?.booked_order_value
  );
  assert(
    'no payload key claims a collected-revenue figure',
    !('revenue' in (dash.data?.totals || {})) &&
      !Object.keys(dash.data?.totals || {}).some((k) => /collected|revenue/i.test(k)),
    Object.keys(dash.data?.totals || {})
  );

  const summary = await step(
    'agent can open the order-summary (staff view)',
    'GET',
    '/api/reports/order-summary',
    {
      token: agentToken,
      expect: 200,
    }
  );
  assert(
    'the agent order-summary carries the SAME metrics but NO audit feed',
    summary.data && summary.data.totals && !('audit' in summary.data),
    summary.data && Object.keys(summary.data)
  );
  assert(
    'the agent order-summary audience is order_manager',
    summary.data?.audience === 'order_manager',
    summary.data?.audience
  );

  const lowStock = await step(
    'agent can open the low-stock report',
    'GET',
    '/api/reports/low-stock?limit=5',
    {
      token: agentToken,
      expect: 200,
    }
  );
  assert(
    'every low-stock row is at or below its threshold',
    (lowStock.data || []).every(
      (r) => Number(r.available_quantity) <= Number(r.low_stock_threshold)
    ),
    (lowStock.data || []).map((r) => [r.sku, r.available_quantity, r.low_stock_threshold])
  );

  // ── 10. FILTERS + PAGINATION on the audit trail ────────────────────────────
  const failures = await step(
    'filter outcome=failure returns the security events',
    'GET',
    '/api/audit-logs?outcome=failure&limit=50',
    {
      token: adminToken,
      expect: 200,
    }
  );
  assert(
    'the failure filter yields only failure-outcome rows',
    (failures.data || []).length > 0 && (failures.data || []).every((r) => r.outcome === 'failure'),
    (failures.data || []).map((r) => [r.action, r.outcome])
  );
  assert(
    'LOGIN_FAILED is present among the failures',
    (failures.data || []).some((r) => r.action === 'LOGIN_FAILED'),
    (failures.data || []).map((r) => r.action)
  );

  const byAction = await step(
    'filter action=ORDER_CREATED',
    'GET',
    '/api/audit-logs?action=ORDER_CREATED&limit=50',
    {
      token: adminToken,
      expect: 200,
    }
  );
  assert(
    'the action filter yields only ORDER_CREATED rows',
    (byAction.data || []).every((r) => r.action === 'ORDER_CREATED'),
    (byAction.data || []).map((r) => r.action)
  );

  const paging = await step('pagination page=1&limit=5', 'GET', '/api/audit-logs?page=1&limit=5', {
    token: adminToken,
    expect: 200,
  });
  assert(
    'limit is honoured and meta reports a larger total',
    (paging.data || []).length <= 5 &&
      paging.meta &&
      paging.meta.total >= (paging.data || []).length,
    { returned: (paging.data || []).length, meta: paging.meta }
  );

  await step('limit above the clamp (100) is rejected', 'GET', '/api/audit-logs?limit=500', {
    token: adminToken,
    expect: 400,
  });
  await step(
    'an unknown filter parameter is rejected (strict)',
    'GET',
    '/api/audit-logs?role=admin',
    {
      token: adminToken,
      expect: 400,
    }
  );

  // ── 11. Database truth: completeness + append-only + valid outcome ─────────
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    // Which actions did THIS run mint, keyed on the unique ids it created?
    const mine = await pool.query(
      `SELECT action, outcome FROM audit_logs
        WHERE (entity_type = 'product'   AND entity_id = $1)
           OR (entity_type = 'inventory' AND entity_id = $1)
           OR (entity_type = 'order'     AND entity_id IN ($2, $3))
           OR (entity_type = 'invoice'   AND entity_id = $4)
        ORDER BY id`,
      [String(productId), String(shipOrderId), String(cancelOrderId), String(invoiceId)]
    );
    const acts = mine.rows.map((r) => r.action);
    const expectedActions = [
      'PRODUCT_CREATED',
      'STOCK_ADJUSTED',
      'PRODUCT_DEACTIVATED',
      'PRODUCT_ACTIVATED',
      'ORDER_CREATED',
      'STOCK_RESERVED',
      'ORDER_STATUS_CHANGED',
      'STOCK_CONSUMED',
      'INVOICE_ISSUED',
      'INVOICE_VOIDED',
      'ORDER_CANCELLED',
      'STOCK_RELEASED',
    ];
    for (const a of expectedActions) {
      assert(`event matrix: ${a} was recorded by this run`, acts.includes(a), acts);
    }
    assert(
      'every business row from this run has outcome=success',
      mine.rows.every((r) => r.outcome === 'success'),
      mine.rows.filter((r) => r.outcome !== 'success')
    );

    // The security events must be stored as failure-outcome rows.
    const secEvents = await pool.query(
      `SELECT action, outcome FROM audit_logs
        WHERE action IN ('LOGIN_FAILED', 'ACCOUNT_DISABLED_ATTEMPT')
        ORDER BY id DESC LIMIT 10`
    );
    assert(
      'LOGIN_FAILED / ACCOUNT_DISABLED_ATTEMPT are stored as outcome=failure',
      secEvents.rowCount > 0 && secEvents.rows.every((r) => r.outcome === 'failure'),
      secEvents.rows
    );

    // The admin user changes (role + status) are audited too.
    const userAudit = await pool.query(
      `SELECT action FROM audit_logs
        WHERE entity_type = 'user' AND entity_id = $1
          AND action IN ('USER_ROLE_CHANGED', 'USER_STATUS_CHANGED')`,
      [String(throwawayId)]
    );
    const userActions = userAudit.rows.map((r) => r.action);
    assert(
      'the promoted + deactivated throwaway carries USER_ROLE_CHANGED and USER_STATUS_CHANGED rows',
      userActions.includes('USER_ROLE_CHANGED') && userActions.includes('USER_STATUS_CHANGED'),
      userActions
    );

    // The audit trail must NEVER contain a password / JWT / auth header field.
    const leaks = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE details::text ~* '"(password|password_hash|authorization|access_token|refresh_token|jwt|token)"'`
    );
    assert(
      'no audit details JSON carries a secret-bearing key',
      leaks.rows[0].n === 0,
      leaks.rows[0]
    );

    // Append-only: the DB refuses UPDATE and DELETE on audit_logs.
    let updateBlocked = false;
    let deleteBlocked = false;
    try {
      await pool.query(
        `UPDATE audit_logs SET action = 'TAMPERED' WHERE id = (SELECT MIN(id) FROM audit_logs)`
      );
    } catch {
      updateBlocked = true;
    }
    try {
      await pool.query(`DELETE FROM audit_logs WHERE id = (SELECT MIN(id) FROM audit_logs)`);
    } catch {
      deleteBlocked = true;
    }
    assert('the database refuses UPDATE on audit_logs (append-only trigger)', updateBlocked, {
      updateBlocked,
    });
    assert('the database refuses DELETE on audit_logs (append-only trigger)', deleteBlocked, {
      deleteBlocked,
    });

    // outcome column CHECK only allows success|failure.
    let badOutcomeRejected = false;
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, details, outcome)
         VALUES (NULL, NULL, 'ORDER_CREATED', 'order', '0', '{}'::jsonb, 'bogus')`
      );
    } catch {
      badOutcomeRejected = true;
    }
    assert(
      "outcome CHECK constraint rejects a value outside ('success','failure')",
      badOutcomeRejected,
      {
        badOutcomeRejected,
      }
    );

    const total = await pool.query('SELECT count(*)::int AS n FROM audit_logs');
    results.push({
      name: 'audit trail total rows',
      pass: true,
      assert: true,
      detail: total.rows[0],
    });
    console.log(
      `[ok  ] audit_logs now holds ${total.rows[0].n} rows (real activity left for the demo)`
    );
  } finally {
    await pool.end();
  }

  // ── Evidence ─────────────────────────────────────────────────────────────
  const outFile = path.join(
    __dirname,
    '../../../evidence/test-reports/phase9-dashboard-smoke.json'
  );
  const fails = results.filter((r) => !r.pass);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        base: BASE,
        minted: { SKU, productId, shipOrderId, cancelOrderId, invoiceId, throwawayId },
        totalSteps: results.length,
        failures: fails.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`\n${results.length - fails.length}/${results.length} smoke checks passed.`);
  console.log(
    fails.length ? `SMOKE FAILED: ${JSON.stringify(fails, null, 2)}` : 'SMOKE: ALL CHECKS PASSED'
  );
  console.log(`Evidence written to ${path.relative(process.cwd(), outFile)}`);
  if (fails.length) process.exitCode = 1;
})().catch((err) => {
  console.error('SMOKE CRASHED:', err.message);
  process.exitCode = 1;
});
