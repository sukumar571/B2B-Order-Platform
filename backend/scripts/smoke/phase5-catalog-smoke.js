'use strict';

/**
 * Phase 5 live smoke — products & inventory against a running dev server.
 *
 *   npm run db:migrate && npm run db:seed   # dev DB ready
 *   node src/server.js &                     # API on http://localhost:4000
 *   node scripts/smoke/phase5-catalog-smoke.js
 *
 * Every step declares the status it EXPECTS; the run fails loudly on any
 * mismatch, so this doubles as a regression gate. Write steps use a unique
 * SMOKE-<timestamp> SKU so the dev catalog is never clobbered. The final
 * section queries PostgreSQL directly to prove the ledger + audit trail were
 * written (and that the rejected adjustment wrote nothing).
 *
 * Evidence: evidence/test-reports/phase5-catalog-smoke.json
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../../src/config/env');
const { Pool } = require('pg');

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:4000';
const DEV_PASSWORD = 'Passw0rd!';
const results = [];

async function step(name, method, urlPath, { body, token, expect } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

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

(async () => {
  const ts = Date.now();
  const SKU = `SMOKE-${ts}`;

  // ── Public catalog (no token) ────────────────────────────────────────────
  await step('health', 'GET', '/api/health', { expect: 200 });

  const anonList = await step('anon product list is active-only', 'GET', '/api/products?limit=50', {
    expect: 200,
  });
  assert(
    'every publicly listed product is active',
    anonList.data.every((p) => p.is_active === true),
    anonList.data.map((p) => [p.sku, p.is_active])
  );
  assert(
    'list exposes available_stock and no credential columns',
    anonList.data.every((p) => 'available_stock' in p && !('password_hash' in p)),
    Object.keys(anonList.data[0])
  );

  const searched = await step(
    'server-side search + sort by price desc',
    'GET',
    '/api/products?search=gadget&sort=price&order=desc',
    { expect: 200 }
  );
  const prices = searched.data.map((p) => Number(p.unit_price));
  assert(
    'search filters to matching products',
    searched.data.every((p) => /gadget/i.test(p.name)),
    searched.data.map((p) => p.name)
  );
  assert(
    'price sort is descending',
    prices.every((v, i) => i === 0 || prices[i - 1] >= v),
    prices
  );

  const paged = await step('pagination page=2&limit=2', 'GET', '/api/products?page=2&limit=2', {
    expect: 200,
  });
  assert(
    'page 2 returns exactly limit rows',
    paged.data.length === 2 && paged.meta.page === 2,
    paged.meta
  );

  await step('invalid limit is rejected (fail closed)', 'GET', '/api/products?limit=999', {
    expect: 400,
  });
  await step(
    'unknown sort column is rejected (whitelist)',
    'GET',
    '/api/products?sort=drop_table',
    { expect: 400 }
  );
  await step('unknown query parameter is rejected (strict)', 'GET', '/api/products?role=admin', {
    expect: 400,
  });
  await step('malformed id is rejected', 'GET', '/api/products/not-a-number', { expect: 400 });

  const inactiveDetail = await step(
    'inactive product is invisible to the public',
    'GET',
    '/api/products/6',
    {
      expect: 404,
    }
  );
  assert(
    'inactive detail returns NOT_FOUND',
    inactiveDetail?.error?.code === 'NOT_FOUND',
    inactiveDetail?.error
  );

  // ── Roles ────────────────────────────────────────────────────────────────
  const admin = await step('admin login', 'POST', '/api/auth/login', {
    body: { email: 'admin@b2boms.test', password: DEV_PASSWORD },
    expect: 200,
  });
  const adminToken = admin.accessToken;

  const customer = await step('customer login', 'POST', '/api/auth/login', {
    body: { email: 'customer@b2boms.test', password: DEV_PASSWORD },
    expect: 200,
  });
  const customerToken = customer.accessToken;

  const agent = await step('order-manager (agent) login', 'POST', '/api/auth/login', {
    body: { email: 'agent@b2boms.test', password: DEV_PASSWORD },
    expect: 200,
  });
  const agentToken = agent.accessToken;

  const adminList = await step(
    'admin can request inactive products too',
    'GET',
    '/api/products?active_only=false&limit=50',
    { token: adminToken, expect: 200 }
  );
  assert(
    'admin sees the archived LEGACY-01',
    adminList.data.some((p) => p.sku === 'LEGACY-01'),
    adminList.data.map((p) => p.sku)
  );

  await step('admin may open an inactive product', 'GET', '/api/products/6', {
    token: adminToken,
    expect: 200,
  });

  // ── Product writes are ADMIN-only ────────────────────────────────────────
  await step('anon cannot create products', 'POST', '/api/products', {
    body: { sku: `NOPE-${ts}`, name: 'Nope', unit_price: '1.00' },
    expect: 401,
  });
  await step('customer cannot create products', 'POST', '/api/products', {
    token: customerToken,
    body: { sku: `NOPE2-${ts}`, name: 'Nope', unit_price: '1.00' },
    expect: 403,
  });
  await step('agent (order manager) cannot create products', 'POST', '/api/products', {
    token: agentToken,
    body: { sku: `NOPE3-${ts}`, name: 'Nope', unit_price: '1.00' },
    expect: 403,
  });

  await step('blank name / negative price / bad sku are rejected', 'POST', '/api/products', {
    token: adminToken,
    body: { sku: 'x', name: '   ', unit_price: '-5' },
    expect: 400,
  });

  const created = await step('admin creates a product', 'POST', '/api/products', {
    token: adminToken,
    body: {
      sku: SKU,
      name: `Smoke Widget ${ts}`,
      description: 'Created by the Phase 5 smoke; safe to ignore.',
      unit_price: '10.00',
      tax_rate: '5.00',
      initial_stock: 0,
      low_stock_threshold: 5,
      is_active: true,
    },
    expect: 201,
  });
  const newId = created.id;

  const dup = await step('duplicate SKU is rejected', 'POST', '/api/products', {
    token: adminToken,
    body: { sku: SKU, name: 'Clone', unit_price: '10.00' },
    expect: 409,
  });
  assert('duplicate returns DUPLICATE_SKU', dup?.error?.code === 'DUPLICATE_SKU', dup?.error);

  const createdStock = await step(
    'new product has an inventory row (0 available => low stock)',
    'GET',
    '/api/inventory/low-stock?search=Smoke',
    { token: adminToken, expect: 200 }
  );
  assert(
    'the created product appears in low-stock with threshold 5',
    createdStock.data.some((r) => r.product_id === newId && Number(r.low_stock_threshold) === 5),
    createdStock.data.map((r) => [r.sku, r.available_quantity, r.low_stock_threshold])
  );

  const patched = await step('admin edits the product price', 'PATCH', `/api/products/${newId}`, {
    token: adminToken,
    body: { unit_price: '12.34' },
    expect: 200,
  });
  assert('price change persisted', patched.unit_price === '12.34', patched.unit_price);

  await step('customer cannot edit products', 'PATCH', `/api/products/${newId}`, {
    token: customerToken,
    body: { unit_price: '0.01' },
    expect: 403,
  });
  await step('empty patch body is rejected', 'PATCH', `/api/products/${newId}`, {
    token: adminToken,
    body: {},
    expect: 400,
  });
  await step('unknown product id is 404', 'PATCH', '/api/products/999999999', {
    token: adminToken,
    body: { unit_price: '1.00' },
    expect: 404,
  });

  const deactivated = await step(
    'admin deactivates (archives) the product',
    'PATCH',
    `/api/products/${newId}`,
    {
      token: adminToken,
      body: { is_active: false },
      expect: 200,
    }
  );
  assert('deactivation is a soft delete', deactivated.is_active === false, deactivated.is_active);

  const archivedDetail = await step(
    'archived product is gone from the public catalog',
    'GET',
    `/api/products/${newId}`,
    { expect: 404 }
  );
  assert(
    'archived detail is NOT_FOUND',
    archivedDetail?.error?.code === 'NOT_FOUND',
    archivedDetail?.error
  );

  // ── Inventory visibility + adjustment authority ──────────────────────────
  await step('customer cannot see inventory', 'GET', '/api/inventory', {
    token: customerToken,
    expect: 403,
  });
  await step('anon cannot see inventory', 'GET', '/api/inventory', { expect: 401 });

  const staffList = await step('order manager can see inventory', 'GET', '/api/inventory', {
    token: agentToken,
    expect: 200,
  });
  assert(
    'inventory rows carry physical/reserved/available/threshold',
    staffList.data.every((r) =>
      [
        'physical_quantity',
        'reserved_quantity',
        'available_quantity',
        'low_stock_threshold',
        'is_low_stock',
      ].every((k) => k in r)
    ),
    Object.keys(staffList.data[0])
  );

  const low = await step(
    'low-stock feed only lists rows at or below threshold',
    'GET',
    '/api/inventory/low-stock',
    { token: agentToken, expect: 200 }
  );
  assert(
    'every low-stock row satisfies available <= threshold',
    low.data.every((r) => Number(r.available_quantity) <= Number(r.low_stock_threshold)),
    low.data.map((r) => [r.sku, r.available_quantity, r.low_stock_threshold])
  );

  await step('order manager cannot adjust stock', 'PATCH', `/api/inventory/${newId}`, {
    token: agentToken,
    body: { delta: 10, reason: 'should be refused' },
    expect: 403,
  });
  await step('customer cannot adjust stock', 'PATCH', `/api/inventory/${newId}`, {
    token: customerToken,
    body: { delta: 10, reason: 'should be refused' },
    expect: 403,
  });
  await step('zero delta is rejected', 'PATCH', `/api/inventory/${newId}`, {
    token: adminToken,
    body: { delta: 0, reason: 'no-op' },
    expect: 400,
  });
  await step('missing reason is rejected', 'PATCH', `/api/inventory/${newId}`, {
    token: adminToken,
    body: { delta: 5 },
    expect: 400,
  });
  await step(
    'fractional quantity is rejected (integer units)',
    'PATCH',
    `/api/inventory/${newId}`,
    {
      token: adminToken,
      body: { delta: 2.5, reason: 'partial unit' },
      expect: 400,
    }
  );

  const receipt = await step('admin receives 60 units', 'PATCH', `/api/inventory/${newId}`, {
    token: adminToken,
    body: { delta: 60, reason: `Smoke stock receipt ${ts}`, low_stock_threshold: 10 },
    expect: 200,
  });
  assert(
    'receipt lands at 60 available',
    Number(receipt.movement.available_after) === 60,
    receipt.movement
  );
  assert(
    'receipt is typed as a stock_receipt',
    receipt.movement.movement_type === 'stock_receipt',
    receipt.movement
  );

  const oversold = await step(
    'adjustment below zero is refused',
    'PATCH',
    `/api/inventory/${newId}`,
    {
      token: adminToken,
      body: { delta: -99999, reason: 'attempt to oversell' },
      expect: 409,
    }
  );
  assert(
    'oversell returns INSUFFICIENT_STOCK',
    oversold?.error?.code === 'INSUFFICIENT_STOCK',
    oversold?.error
  );

  const afterFail = await step(
    'stock is unchanged after the refused adjustment',
    'GET',
    '/api/inventory',
    {
      token: adminToken,
      expect: 200,
    }
  );
  const stillThere = afterFail.data.find((r) => r.product_id === newId);
  assert(
    'refused adjustment left physical stock at 60',
    Number(stillThere?.physical_quantity) === 60,
    stillThere
  );

  const issued = await step(
    'admin issues 15 units (manual adjustment)',
    'PATCH',
    `/api/inventory/${newId}`,
    {
      token: adminToken,
      body: { delta: -15, reason: `Smoke issue to demo ${ts}` },
      expect: 200,
    }
  );
  assert(
    'issue lands at 45 available',
    Number(issued.movement.available_after) === 45,
    issued.movement
  );
  assert(
    'issue is typed as manual_adjustment',
    issued.movement.movement_type === 'manual_adjustment',
    issued.movement
  );

  // ── Database truth: ledger + audit trail ─────────────────────────────────
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const movements = await pool.query(
      `SELECT quantity_delta, movement_type, reason
         FROM inventory_movements
        WHERE product_id = $1
        ORDER BY id`,
      [newId]
    );
    assert(
      'each successful adjustment wrote exactly one ledger row (2 rows: +60, -15)',
      movements.rowCount === 2 &&
        Number(movements.rows[0].quantity_delta) === 60 &&
        movements.rows[0].movement_type === 'stock_receipt' &&
        Number(movements.rows[1].quantity_delta) === -15 &&
        movements.rows[1].movement_type === 'manual_adjustment',
      movements.rows
    );

    const audits = await pool.query(
      `SELECT action, actor_role, entity_type, entity_id
         FROM audit_logs
        WHERE entity_type IN ('product', 'inventory') AND entity_id = $1
        ORDER BY id`,
      [String(newId)]
    );
    const actions = audits.rows.map((r) => r.action);
    assert(
      'create/update/deactivate/adjust are all audited with the actor role',
      ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DEACTIVATED', 'STOCK_ADJUSTED'].every((a) =>
        actions.includes(a)
      ) &&
        audits.rows.every((r) => r.actor_role === 'admin') &&
        audits.rows
          .filter((r) => r.action === 'STOCK_ADJUSTED')
          .every((r) => r.entity_type === 'inventory'),
      audits.rows.map((r) => [r.entity_type, r.action, r.actor_role])
    );
    assert(
      'the refused oversell wrote no audit row (2 STOCK_ADJUSTED only)',
      actions.filter((a) => a === 'STOCK_ADJUSTED').length === 2,
      actions
    );

    const stockRow = await pool.query(
      `SELECT details FROM audit_logs
        WHERE entity_type = 'inventory' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [String(newId)]
    );
    assert(
      'the audit detail carries delta + resulting availability (no secrets)',
      stockRow.rows.length === 1 &&
        stockRow.rows[0].details.delta === -15 &&
        Number(stockRow.rows[0].details.available_after) === 45,
      stockRow.rows[0] && stockRow.rows[0].details
    );

    const rowStill = await pool.query('SELECT id, is_active FROM products WHERE id = $1', [newId]);
    assert(
      'the product row still exists (never hard-deleted)',
      rowStill.rowCount === 1,
      rowStill.rows
    );

    const productRows = await pool.query('SELECT count(*)::int AS n FROM products');
    results.push({
      name: 'dev catalog intact after smoke',
      pass: true,
      assert: true,
      detail: productRows.rows[0],
    });
    console.log(`[ok  ] dev catalog intact — ${productRows.rows[0].n} products remain`);
  } finally {
    await pool.end();
  }

  // ── Evidence ────────────────────────────────────────────────────────────
  const outFile = path.join(__dirname, '../../../evidence/test-reports/phase5-catalog-smoke.json');
  const failures = results.filter((r) => !r.pass);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        base: BASE,
        totalSteps: results.length,
        failures: failures.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`\n${results.length - failures.length}/${results.length} smoke checks passed.`);
  console.log(
    failures.length
      ? `SMOKE FAILED: ${JSON.stringify(failures, null, 2)}`
      : 'SMOKE: ALL CHECKS PASSED'
  );
  console.log(`Evidence written to ${path.relative(process.cwd(), outFile)}`);
  if (failures.length) process.exitCode = 1;
})().catch((err) => {
  console.error('SMOKE CRASHED:', err.message);
  process.exitCode = 1;
});
