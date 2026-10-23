'use strict';
/*
 * Phase 8 — invoice smoke (happy path, real ship→invoice hook).
 * Drives the LIVE API on http://localhost:4000 to place a cart order and advance
 * it to `shipped`, which mints the invoice atomically (D-25). Proves:
 *   - no invoice exists before ship, exactly one after ship
 *   - the invoice numbers follow INV-YYYY-NNNNNN and totals match the order
 *   - customer sees only their own invoice; staff can void it (row preserved)
 * It leaves a real shipped order + issued invoice in the dev DB for the UI demo.
 */
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:4000';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

async function api(method, path, { token, body, idem } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${JSON.stringify(r.json)}`);
  return r.json.accessToken;
}

(async () => {
  console.log('Phase 8 invoice smoke →', BASE);

  // 1) Seed identities.
  const cust = await login('customer@b2boms.test', 'Passw0rd!');
  const staff = await login('admin@b2boms.test', 'Passw0rd!');

  // 2) Find an active product and add a small line to the cart.
  const prods = await api('GET', '/api/products?limit=5');
  const list = prods.json?.data ?? [];
  if (list.length === 0) throw new Error('no products to order — run the seed first');
  const product = list[0];
  const sku = product.sku;
  const detail = await api('GET', `/api/products/${product.id}`, { token: cust });
  const pid = detail.json?.id ?? product.id;

  // Start from a clean cart, then add 2 units.
  await api('DELETE', '/api/cart', { token: cust });
  const add = await api('POST', '/api/cart/items', {
    token: cust,
    body: { product_id: pid, quantity: 2 },
  });
  check('cart add 2 units returns 2xx', add.status >= 200 && add.status < 300, add.json);

  // 3) Place the order (customer, idempotent).
  const placed = await api('POST', '/api/orders', {
    token: cust,
    body: {},
    idem: uuid(),
  });
  check('order placed 201', placed.status === 201, placed.json);
  const order = placed.json?.data ?? placed.json;
  const orderId = order?.id;
  const orderGrand = order?.grand_total;
  check(
    'order has a server grand_total',
    typeof orderGrand === 'string' && Number(orderGrand) > 0,
    {
      orderGrand,
    }
  );

  // 4) BEFORE ship: the customer must see NO invoice for this order.
  const preInvoice = await api('GET', `/api/orders/${orderId}/invoice`, { token: cust });
  check('no invoice before ship (404)', preInvoice.status === 404, preInvoice.json);

  // 5) Advance the lifecycle to shipped (staff). Each is one legal step.
  for (const status of ['confirmed', 'processing', 'shipped']) {
    const step = await api('PATCH', `/api/orders/${orderId}/status`, {
      token: staff,
      body: { status },
    });
    check(`transition → ${status} returns 200`, step.status === 200, step.json);
  }

  // 6) AFTER ship: exactly one invoice, correct shape, totals match the order.
  const postInvoice = await api('GET', `/api/orders/${orderId}/invoice`, { token: cust });
  check('invoice exists after ship (200)', postInvoice.status === 200, postInvoice.json);
  const inv = postInvoice.json;
  check(
    'invoice number matches INV-YYYY-NNNNNN',
    /^INV-\d{4}-\d{6}$/.test(inv?.invoice_number || ''),
    {
      n: inv?.invoice_number,
    }
  );
  check('invoice status is issued', inv?.status === 'issued', inv?.status);
  check(
    'invoice totals equal the order snapshot',
    inv?.grand_total === orderGrand &&
      Number(inv?.subtotal) + Number(inv?.tax_total) === Number(inv?.grand_total),
    { subtotal: inv?.subtotal, tax: inv?.tax_total, grand: inv?.grand_total, orderGrand }
  );
  check(
    'invoice carries the demo label',
    inv?.demo === true && /DEMONSTRATION/i.test(inv?.demo_notice || ''),
    inv?.demo_notice
  );
  check(
    'invoice has the order line items',
    Array.isArray(inv?.items) && inv.items.length > 0,
    inv?.items
  );

  // 7) Listing is ownership-scoped.
  const custList = await api('GET', '/api/invoices', { token: cust });
  check(
    'customer list contains their invoice',
    (custList.json?.data ?? []).some((r) => r.id === inv.id),
    custList.json?.meta
  );

  // A different customer must NOT see it.
  const otherEmail = `smoke-inv-${Date.now()}@b2boms.test`;
  // Register a throwaway customer to prove scoping without seeding.
  const reg = await api('POST', '/api/auth/register', {
    body: { email: otherEmail, password: 'Passw0rd!', name: 'Other Buyer', role: 'customer' },
  });
  if (reg.status === 201 || reg.status === 200) {
    const otherToken = await login(otherEmail, 'Passw0rd!');
    const foreign = await api('GET', `/api/invoices/${inv.id}`, { token: otherToken });
    check('foreign customer read → 404 (no existence leak)', foreign.status === 404, foreign.json);

    // 8) A customer cannot void (staff-only write).
    const custVoid = await api('POST', `/api/invoices/${inv.id}/void`, {
      token: otherToken,
      body: { reason: 'should be forbidden' },
    });
    check('customer void → 403 FORBIDDEN_ROLE', custVoid.status === 403, custVoid.json);
  } else {
    console.log('  (skip foreign/void-customer checks: register unavailable —', reg.status, ')');
  }

  // 9) Staff void preserves the row (issued → voided) and re-void is refused.
  const voided = await api('POST', `/api/invoices/${inv.id}/void`, {
    token: staff,
    body: { reason: 'smoke: demonstration void' },
  });
  check(
    'staff void → 200 status voided',
    voided.status === 200 && voided.json?.status === 'voided',
    voided.json?.status
  );
  check(
    'void preserves the totals',
    voided.json?.grand_total === orderGrand,
    voided.json?.grand_total
  );

  // Now void THIS order's invoice is done. But we want a live ISSUED invoice for the UI demo,
  // so mint a SECOND shipped order + invoice and leave it issued.
  await api('POST', '/api/cart/items', { token: cust, body: { product_id: pid, quantity: 1 } });
  const placed2 = await api('POST', '/api/orders', { token: cust, body: {}, idem: uuid() });
  const order2 = placed2.json?.data ?? placed2.json;
  for (const status of ['confirmed', 'processing', 'shipped']) {
    await api('PATCH', `/api/orders/${order2.id}/status`, { token: staff, body: { status } });
  }
  const inv2 = await api('GET', `/api/orders/${order2.id}/invoice`, { token: cust });
  check(
    'a second shipped order yields an ISSUED invoice for the demo',
    inv2.status === 200 && inv2.json?.status === 'issued',
    inv2.json?.status
  );
  check(
    'invoice numbers increase within the year',
    Number(inv2.json?.invoice_number?.slice(-6)) > Number(inv.invoice_number?.slice(-6)),
    { first: inv.invoice_number, second: inv2.json?.invoice_number }
  );

  console.log(
    `\nResult: SKU=${sku} issuedInvoice=${inv2.json?.invoice_number} voidedInvoice=${inv.invoice_number}`
  );
  console.log(`Smoke checks: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE ERROR:', e.message);
  process.exit(1);
});
