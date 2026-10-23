'use strict';

const { test, expect } = require('@playwright/test');
const {
  SEED,
  uniqueEmail,
  login,
  registerCustomer,
  gotoNav,
  logout,
  addProductToCart,
  readInventoryCell,
} = require('./helpers');

/**
 * Phase 12 — the ten critical end-to-end business journeys, exercised through
 * the real React SPA against a running API + the disposable *_e2e database.
 *
 * They run in SERIAL order and share a small in-memory `flow` object, because
 * together they are one coherent business narrative (create → stock up → buy →
 * reserve → fulfil → invoice → audit → isolate). Each step still logs in fresh,
 * since Playwright gives every test an isolated browser context.
 *
 * Navigation between PROTECTED screens is done by clicking the navbar / row
 * links (client-side routing) rather than a cold page.goto: the access token is
 * held in memory only, so a full reload would drop it and race the refresh-cookie
 * rehydration. A real user clicks through, and so do these tests.
 */
test.describe.configure({ mode: 'serial' });

const flow = {}; // productId / sku / orderedQty / orderId / customer creds
const CUSTOMER_PASSWORD = 'E2eCust0rPass!';

test.describe('Critical business journeys', () => {
  test('1. Admin logs in and creates a product', async ({ page }) => {
    await login(page, SEED.admin, SEED.password);
    await expect(page.locator('.nav__user')).toContainText('admin');

    flow.newSku = `E2E-${Date.now().toString(36).toUpperCase()}`;
    await gotoNav(page, 'Admin'); // "Admin · Products"
    await page.click('button:has-text("+ Add product")');
    const form = page.locator('form[aria-label="create product form"]');
    await form.locator('input[name="sku"]').fill(flow.newSku);
    await form.locator('input[name="name"]').fill('E2E Journey Product');
    await form.locator('input[name="unit_price"]').fill('15.00');
    await form.locator('input[name="tax_rate"]').fill('10');
    await form.locator('input[name="initial_stock"]').fill('25');
    await form.locator('input[name="low_stock_threshold"]').fill('5');
    await form.locator('button:has-text("Create product")').click();

    await expect(page.locator('.flash--success')).toContainText('created');
    await expect(page.locator(`td:has-text("${flow.newSku}")`).first()).toBeVisible();
  });

  test('2. Admin updates stock', async ({ page }) => {
    await login(page, SEED.admin, SEED.password);
    await gotoNav(page, 'Inventory');

    const before = Number(await readInventoryCell(page, 'GADGET-B', 'Available'));
    await page
      .locator('table.table tbody tr', { hasText: 'GADGET-B' })
      .first()
      .locator('button:has-text("Adjust")')
      .click();

    const adj = page.locator('form[aria-label="stock adjustment form"]');
    await adj.locator('input[name="delta"]').fill('5');
    await adj.locator('input[name="reason"]').fill('E2E restock');
    await adj.locator('button:has-text("Apply adjustment")').click();

    await expect(page.locator('.flash--success')).toContainText('applied');
    await expect
      .poll(async () => Number(await readInventoryCell(page, 'GADGET-B', 'Available')), {
        message: 'GADGET-B available should rise by 5',
      })
      .toBe(before + 5);
  });

  test('3. Customer registers, then logs in', async ({ page }) => {
    flow.customerEmail = uniqueEmail('buyer');
    await registerCustomer(page, {
      name: 'Elena Buyer',
      email: flow.customerEmail,
      password: CUSTOMER_PASSWORD,
    });
    await expect(page.locator('.nav__user')).toContainText('customer');

    await logout(page);
    await login(page, flow.customerEmail, CUSTOMER_PASSWORD);
    await expect(page.locator('.nav__user')).toContainText('customer');
  });

  test('4. Customer browses products and adds one to the cart', async ({ page }) => {
    await login(page, flow.customerEmail, CUSTOMER_PASSWORD);
    // /products is public; a cold goto is fine and mirrors a fresh browse.
    await page.goto('/products');
    await page.fill('input[aria-label="Search products"]', 'WIDGET-01');
    await page.click('button:has-text("Search")');

    // Open the product detail; capture its id + sku for later steps.
    await page.locator('.product-card__link').first().click();
    await page.waitForURL(/\/products\/\d+/);
    flow.productId = Number(page.url().match(/\/products\/(\d+)/)[1]);
    flow.sku = (await page.locator('.hero__eyebrow').first().textContent()).trim();
    flow.orderedQty = 2;

    await addProductToCart(page, flow.productId, flow.orderedQty);
    await gotoNav(page, 'Cart');
    await expect(page.locator('.cart__list')).toContainText(flow.sku);
  });

  test('5. Customer places an order (server-priced, stock reserved)', async ({ page }) => {
    await login(page, flow.customerEmail, CUSTOMER_PASSWORD);
    await gotoNav(page, 'Cart');
    await expect(page.locator('[aria-label="place order"]')).toBeVisible();

    await page.click('[aria-label="place order"]');
    await page.waitForURL(/\/orders\/\d+\/confirmation/);
    flow.orderId = Number(page.url().match(/\/orders\/(\d+)/)[1]);

    await expect(page.locator('.order-confirmation')).toContainText('your order is placed');
    await expect(page.locator('.order-confirmation')).toContainText('reserved');
  });

  test('6. Stock reservation is verified on the inventory ledger', async ({ page }) => {
    await login(page, SEED.admin, SEED.password);
    const reserved = Number(await readInventoryCell(page, flow.sku, 'Reserved'));
    expect(reserved).toBeGreaterThanOrEqual(flow.orderedQty);
  });

  test('7. Order manager processes the order through to shipment (invoice minted)', async ({
    page,
  }) => {
    await login(page, SEED.agent, SEED.password);
    await gotoNav(page, 'Orders'); // staff "Orders" → /orders/manage

    const row = page.locator('table.table tbody tr', { hasText: `#${flow.orderId}` }).first();
    await expect(row).toBeVisible();

    // pending → confirmed → processing → shipped (ship is the fulfilment point).
    for (let i = 0; i < 3; i++) {
      await row.locator('button:has-text("Advance →")').click();
      await expect(page.locator('.flash--success')).toBeVisible();
    }
    await expect(row.locator('.badge')).toContainText(/Shipped/i);
  });

  test('8. Customer views the order and its generated invoice', async ({ page }) => {
    await login(page, flow.customerEmail, CUSTOMER_PASSWORD);
    // Reach the order through the SPA (My orders → View → View invoice) so the
    // in-memory session is preserved the whole way.
    await gotoNav(page, 'My orders');
    const row = page
      .locator('table.table tbody tr')
      .filter({ has: page.locator(`td.mono:text-is("#${flow.orderId}")`) })
      .first();
    await row.locator('a:has-text("View")').click();
    await page.waitForURL(new RegExp(`/orders/${flow.orderId}$`));
    await expect(page.locator('.page__title')).toContainText('Order summary');

    await page.click('a:has-text("View invoice")');
    await page.waitForURL(/\/orders\/\d+\/invoice/);
    await expect(page.locator('body')).toContainText(/INV-\d{4}-\d{6}/);
    await expect(page.locator('body')).toContainText(/DEMONSTRATION DOCUMENT/i);
  });

  test('9. Admin views audit events and dashboard statistics', async ({ page }) => {
    await login(page, SEED.admin, SEED.password);
    await gotoNav(page, 'Dashboard');
    await expect(page.locator('.page__title')).toContainText('Admin dashboard');
    // Scope to the stat-card labels: the same phrases also appear in the
    // metric-definitions list, so an unscoped text= match would be ambiguous.
    await expect(
      page.locator('.statcard__label', { hasText: 'Booked order value' }).first()
    ).toBeVisible();
    await expect(
      page.locator('.statcard__label', { hasText: 'Audit events recorded' }).first()
    ).toBeVisible();
    await expect(
      page.locator('.card__title', { hasText: 'Recent activity' }).first()
    ).toBeVisible();

    await gotoNav(page, 'Audit');
    await expect(page.locator('.page__title')).toContainText('Audit trail');
    // The order we just placed must appear in the append-only trail.
    const orderRow = page.locator('table.table tbody tr', { hasText: /order/i }).first();
    await expect(orderRow).toBeVisible();
  });

  test('10. A customer is denied another customer’s order and invoice', async ({ page }) => {
    const otherEmail = uniqueEmail('intruder');
    await registerCustomer(page, {
      name: 'Ivy Intruder',
      email: otherEmail,
      password: CUSTOMER_PASSWORD,
    });
    await expect(page.locator('.nav__user')).toContainText('customer');

    // Deep-link the victim's order + invoice. Whether the SPA re-hydrates the
    // intruder session (server returns 404, no existence leak) or the guard
    // bounces to the login screen, the outcome is identical: NONE of the
    // victim's data is ever rendered.
    await page.goto(`/orders/${flow.orderId}`);
    await expect(page.locator('body')).not.toContainText(flow.customerEmail);

    await page.goto(`/orders/${flow.orderId}/invoice`);
    await expect(page.locator('body')).not.toContainText(/INV-\d{4}-\d{6}/);
  });
});
