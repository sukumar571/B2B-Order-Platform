'use strict';

const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { SEED, API_URL, uniqueEmail, apiLogin, apiToken } = require('./helpers');

/**
 * Phase 12 — negative / adversarial paths.
 *
 * These drive the REST API directly through Playwright's `request` fixture so we
 * assert the SERVER's authoritative rules, not a friendly UI: insufficient stock,
 * invalid quantities, duplicate (idempotent) requests, inactive products, atomic
 * database rollback, and every unauthorized action. The disposable `*_e2e`
 * database is provisioned by globalSetup, so nothing here can touch dev/prod.
 */
test.describe.configure({ mode: 'serial' });

// Customer accounts used across the suite; `flow` carries shared ids/order refs.
const flow = {};
const CUST_PASS = 'E2eNegPass!';

/** Resolve a product id by SKU using an ADMIN token (sees active AND inactive). */
async function findProductId(request, adminToken, sku) {
  const res = await request.get(`${API_URL}/api/products`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    params: { active_only: 'false', limit: 100 },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const hit = body.data.find((p) => p.sku === sku);
  if (!hit) throw new Error(`seed product ${sku} not found in e2e catalog`);
  return hit;
}

/** Current available_stock for a product id (admin token → sees inactive too). */
async function readAvailable(request, adminToken, productId) {
  const res = await request.get(`${API_URL}/api/products/${productId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.ok()).toBeTruthy();
  // GET /api/products/:id returns the product object directly (no envelope).
  return Number((await res.json()).available_stock);
}

test.describe('Negative and adversarial paths', () => {
  test.beforeAll(async ({ request }) => {
    flow.adminToken = await apiToken(request, SEED.admin);
    flow.agentToken = await apiToken(request, SEED.agent);

    // A fresh self-registered customer for the order/cart flows.
    flow.custEmail = uniqueEmail('neg');
    const reg = await request.post(`${API_URL}/api/auth/register`, {
      data: { name: 'Neg Tester', email: flow.custEmail, password: CUST_PASS },
    });
    expect(reg.status()).toBe(201);
    flow.custToken = (await reg.json()).accessToken;

    flow.gadgetB = await findProductId(request, flow.adminToken, 'GADGET-B'); // active, low stock
    flow.legacy = await findProductId(request, flow.adminToken, 'LEGACY-01'); // inactive
    flow.widget = await findProductId(request, flow.adminToken, 'WIDGET-01'); // active, deep stock
  });

  test('Insufficient stock is rejected (409) and does not alter the cart', async ({ request }) => {
    const available = Number(flow.gadgetB.available_stock);
    const res = await request.post(`${API_URL}/api/cart/items`, {
      headers: { Authorization: `Bearer ${flow.custToken}` },
      data: { product_id: flow.gadgetB.id, quantity: available + 1 },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_STOCK');

    // The rejected line must NOT linger in the cart.
    const cart = await (
      await request.get(`${API_URL}/api/cart`, {
        headers: { Authorization: `Bearer ${flow.custToken}` },
      })
    ).json();
    expect(cart.items.some((i) => i.product_id === String(flow.gadgetB.id))).toBe(false);
  });

  test('Invalid quantities are rejected by validation (400)', async ({ request }) => {
    for (const bad of [0, -5, 2.5]) {
      const res = await request.post(`${API_URL}/api/cart/items`, {
        headers: { Authorization: `Bearer ${flow.custToken}` },
        data: { product_id: flow.widget.id, quantity: bad },
      });
      expect(res.status(), `quantity ${bad} should fail validation`).toBe(400);
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('Inactive products cannot be added or ordered (404)', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/cart/items`, {
      headers: { Authorization: `Bearer ${flow.custToken}` },
      data: { product_id: flow.legacy.id, quantity: 1 },
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('PRODUCT_NOT_FOUND');
  });

  test('A failing multi-line order rolls back atomically (no order, stock unchanged)', async ({
    request,
  }) => {
    const gadgetBefore = await readAvailable(request, flow.adminToken, flow.gadgetB.id);
    const widgetBefore = await readAvailable(request, flow.adminToken, flow.widget.id);

    // One affordable line + one impossible line → the whole order must abort.
    const before = await (
      await request.get(`${API_URL}/api/orders`, {
        headers: { Authorization: `Bearer ${flow.custToken}` },
        params: { limit: 1 },
      })
    ).json();

    const res = await request.post(`${API_URL}/api/orders`, {
      headers: {
        Authorization: `Bearer ${flow.custToken}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      data: {
        items: [
          { product_id: flow.widget.id, quantity: 1 }, // fine
          { product_id: flow.gadgetB.id, quantity: Number(flow.gadgetB.available_stock) + 50 }, // impossible
        ],
      },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('INSUFFICIENT_STOCK');

    // Rollback proof: neither product's availability moved, and no order appeared.
    expect(await readAvailable(request, flow.adminToken, flow.gadgetB.id)).toBe(gadgetBefore);
    expect(await readAvailable(request, flow.adminToken, flow.widget.id)).toBe(widgetBefore);

    const after = await (
      await request.get(`${API_URL}/api/orders`, {
        headers: { Authorization: `Bearer ${flow.custToken}` },
        params: { limit: 1 },
      })
    ).json();
    expect(after.meta.total).toBe(before.meta.total);
  });

  test('Duplicate requests are idempotent (one order, replayed response)', async ({ request }) => {
    // Use an EXPLICIT items[] body (not the cart): a completed order empties
    // the cart, so a cart-derived replay would hit EMPTY_CART before the
    // idempotency claim is reached. Explicit identical lines exercise the claim.
    const items = [{ product_id: flow.widget.id, quantity: 3 }];
    const key = crypto.randomUUID();
    const headers = { Authorization: `Bearer ${flow.custToken}`, 'Idempotency-Key': key };

    const first = await request.post(`${API_URL}/api/orders`, { headers, data: { items } });
    expect(first.status()).toBe(201);
    const firstBody = await first.json();

    const replay = await request.post(`${API_URL}/api/orders`, { headers, data: { items } });
    // A completed claim replays the original body with an idempotent marker (200).
    expect(replay.status()).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.idempotent).toBe(true);
    expect(replayBody.id).toBe(firstBody.id); // SAME order — never double-created

    // And a DIFFERENT body under the SAME key is refused (409) — the key is
    // bound to one exact request fingerprint.
    const conflict = await request.post(`${API_URL}/api/orders`, {
      headers,
      data: { items: [{ product_id: flow.widget.id, quantity: 7 }] },
    });
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');

    flow.dupOrderId = firstBody.id;
  });

  test('Unauthorized actions are refused at the API boundary', async ({ request }) => {
    // Anonymous cannot read orders.
    const anon = await request.get(`${API_URL}/api/orders`);
    expect(anon.status()).toBe(401);

    // A customer cannot advance another (or any) order's status — staff only.
    const custPatch = await request.patch(`${API_URL}/api/orders/${flow.dupOrderId}/status`, {
      headers: { Authorization: `Bearer ${flow.custToken}` },
      data: { status: 'confirmed' },
    });
    expect(custPatch.status()).toBe(403);

    // A customer cannot read the admin audit trail.
    const custAudit = await request.get(`${API_URL}/api/audit-logs`, {
      headers: { Authorization: `Bearer ${flow.custToken}` },
    });
    expect(custAudit.status()).toBe(403);

    // An order manager cannot create products (admin only).
    const agentProduct = await request.post(`${API_URL}/api/products`, {
      headers: { Authorization: `Bearer ${flow.agentToken}` },
      data: { sku: 'NOPE-1', name: 'Nope', unit_price: '1.00', tax_rate: '0.00' },
    });
    expect(agentProduct.status()).toBe(403);
  });

  test('A disabled account cannot obtain a token (403)', async ({ request }) => {
    const res = await apiLoginDisabled(request);
    expect(res.status).toBe(403);
    expect(res.code).toBe('ACCOUNT_DISABLED');
  });
});

/** Login the seeded disabled account and surface {status, code} without throwing. */
async function apiLoginDisabled(request) {
  const res = await request.post(`${API_URL}/api/auth/login`, {
    data: { email: 'disabled@b2boms.test', password: SEED.password },
  });
  let code = null;
  try {
    code = (await res.json()).error?.code ?? null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status(), code };
}
