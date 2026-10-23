#!/usr/bin/env node
'use strict';

/**
 * Deployment smoke check (Phase 13).
 *
 *   node scripts/deploy-smoke.js [base-url]
 *   npm run docker:smoke            # http://localhost:8080
 *
 * Drives a running stack through the PUBLIC browser origin only — i.e. it
 * proves the whole chain browser → nginx (SPA + /api proxy) → Express →
 * PostgreSQL, not just that a container is up. Nothing here writes data:
 * every call is a read or an idempotent login. Exit code 0 = all checks pass.
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:8080').replace(
  /\/+$/,
  ''
);

const results = [];

/** Record one check. */
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** GET a path and return { status, body, headers }. */
async function get(path, { cookie = '' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

(async () => {
  console.log(`Deployment smoke against ${BASE}\n`);

  // 1. SPA is served, and client-side routes fall back to index.html.
  for (const path of ['/', '/products', '/login']) {
    const r = await get(path);
    check(
      `SPA ${path}`,
      r.status === 200 && /<div id="root">/.test(r.text) && /type="module"/.test(r.text),
      `HTTP ${r.status}, ${r.headers.get('content-type')}`
    );
  }

  // 2. nginx proxies /api to the backend service, and the API reports the DB up.
  const health = await get('/api/health');
  let healthBody = null;
  try {
    healthBody = JSON.parse(health.text);
  } catch {
    /* reported by the check below */
  }
  check(
    'GET /api/health via proxy',
    health.status === 200 && healthBody?.status === 'ok' && healthBody?.db?.state === 'up',
    health.text.slice(0, 160)
  );

  // 3. The proxied API reaches PostgreSQL through the Compose service name.
  const catalog = await get('/api/products?limit=1');
  let catalogBody = null;
  try {
    catalogBody = JSON.parse(catalog.text);
  } catch {
    /* reported below */
  }
  check(
    'GET /api/products (db-backed)',
    catalog.status === 200 && Array.isArray(catalogBody?.data),
    `total=${catalogBody?.meta?.total ?? 'n/a'}`
  );

  // 4. Authorization is enforced over the real network path.
  const anonCart = await get('/api/cart');
  check(
    'GET /api/cart anonymous → 401',
    anonCart.status === 401,
    `HTTP ${anonCart.status} ${anonCart.text.slice(0, 80)}`
  );

  // 5. A seeded admin can log in through the proxy and receive a hardened
  //    refresh cookie; the access token then authorises a staff-only read.
  //    Dev seed credentials only — never used outside a local demo stack.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SMOKE_ADMIN_EMAIL || 'admin@b2boms.test',
      password: process.env.SMOKE_ADMIN_PASSWORD || 'Passw0rd!',
    }),
  });
  const loginBody = await login.json().catch(() => null);
  check(
    'POST /api/auth/login (admin)',
    login.status === 200 && !!loginBody?.accessToken,
    `HTTP ${login.status}`
  );

  const setCookie = login.headers.get('set-cookie') || '';
  check(
    'refresh cookie is HttpOnly + SameSite=Strict + Secure',
    /HttpOnly/i.test(setCookie) && /samesite=strict/i.test(setCookie) && /secure/i.test(setCookie),
    setCookie.replace(/=[^;]+;/, '=***;').slice(0, 140)
  );

  if (loginBody?.accessToken) {
    const stats = await fetch(`${BASE}/api/reports/dashboard`, {
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
    });
    const statsBody = await stats.json().catch(() => null);
    check(
      'GET /api/reports/dashboard (admin role)',
      stats.status === 200 && statsBody !== null,
      `HTTP ${stats.status}`
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed: ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
})().catch((err) => {
  console.error(`Smoke run crashed: ${err.message}`);
  process.exit(1);
});
