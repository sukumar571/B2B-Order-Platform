'use strict';

const { API_URL } = require('../e2e-env');

/**
 * Reusable browser helpers for the Phase 12 E2E suite. All UI actions go through
 * the same accessible controls a real user uses (login/register forms, nav links,
 * add-to-cart, checkout, lifecycle "Advance" buttons) — the tests never reach into
 * React internals or bypass the server.
 *
 * The `api*` helpers drive the SAME REST endpoints over Playwright's request
 * fixture (direct Bearer calls). They are used by the negative-path suite to
 * assert the server's authoritative behaviour (validation, stock, idempotency,
 * RBAC) — the browser cannot be tricked into accepting what the API rejects.
 */

const SEED = {
  password: 'Passw0rd!',
  admin: 'admin@b2boms.test',
  agent: 'agent@b2boms.test',
  customer: 'customer@b2boms.test',
};

let counter = 0;
/** A unique email for a throwaway self-registered customer. */
function uniqueEmail(tag = 'e2e') {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}-${counter}@e2e.test`;
}

/** Log in through the /login form and wait until the SPA shows the signed-in user. */
async function login(page, email, password) {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(products|orders|cart|dashboard|inventory)/, { timeout: 8000 });
}

/** Register a brand-new customer through the public /register form (role forced to customer). */
async function registerCustomer(page, { name, email, password }) {
  await page.goto('/register');
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="confirm"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/products/, { timeout: 8000 });
}

/**
 * Navigate to a protected SPA route by CLICKING a navbar link rather than a cold
 * page.goto. The access token is held in memory only, so a full reload would
 * drop it and race the cookie rehydration (see AuthContext / RequireRole).
 * Client-side navigation keeps the live session and is what a real user does.
 */
async function gotoNav(page, label) {
  await page.click(`.nav__links >> text=${label}`);
}

/** Log out via the navbar button (no-op when already anonymous). */
async function logout(page) {
  const btn = page.locator('.nav__auth >> button:has-text("Log out")');
  if (await btn.count()) {
    await btn.click();
    await page.waitForSelector('text=Log in', { timeout: 8000 });
  }
}

/**
 * Add a product to the cart from its detail page. /products and /products/:id
 * are PUBLIC routes, so a cold goto here never touches the auth guard.
 */
async function addProductToCart(page, productId, quantity) {
  await page.goto(`/products/${productId}`);
  await page.waitForSelector('form[aria-label="add to cart form"]');
  await page.fill('input[name="quantity"]', String(quantity));
  await page.click('form[aria-label="add to cart form"] button[type="submit"]');
  await page.waitForSelector('.add-to-cart__ok', { timeout: 8000 });
}

/** Read the numeric text of a column for a SKU on the inventory table (staff session). */
async function readInventoryCell(page, sku, column) {
  await gotoNav(page, 'Inventory');
  await page.waitForSelector('table.table');
  const headers = (await page.locator('table.table thead th').allTextContents()).map((h) =>
    h.trim().toLowerCase()
  );
  const colIndex = headers.indexOf(column.toLowerCase());
  if (colIndex === -1) throw new Error(`inventory column "${column}" not found`);
  const row = page.locator(`table.table tbody tr:has(td:has-text("${sku}"))`).first();
  await row.waitFor();
  const cells = await row.locator('td').allTextContents();
  return cells[colIndex].trim();
}

/** Log in over the REST API and return the raw JSON envelope (incl. accessToken). */
async function apiLogin(request, email, password = SEED.password) {
  const res = await request.post(`${API_URL}/api/auth/login`, {
    data: { email, password },
  });
  if (!res.ok()) {
    throw new Error(`apiLogin failed for ${email}: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

/** Log in and return just the Bearer access token. */
async function apiToken(request, email, password) {
  const { accessToken } = await apiLogin(request, email, password);
  return accessToken;
}

module.exports = {
  SEED,
  API_URL,
  uniqueEmail,
  login,
  registerCustomer,
  gotoNav,
  logout,
  addProductToCart,
  readInventoryCell,
  apiLogin,
  apiToken,
};
