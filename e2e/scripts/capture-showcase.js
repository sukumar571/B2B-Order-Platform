'use strict';

/**
 * Showcase capture for marketing/social use (LinkedIn post).
 *
 * Drives the running dev stack (backend on :4000, Vite on :5173) in a real
 * Chromium at a desktop viewport and writes:
 *   - PNG stills of the home page, admin dashboard, agent dashboard and the
 *     customer view  -> ../images/
 *   - one MP4 walkthrough (H.264, LinkedIn-playable) of the three role journeys
 *     -> ../images/video/
 *
 * Navigation into protected routes happens by CLICKING sidebar links, never by a
 * cold page.goto: the access token lives in memory only, so a reload would drop
 * the session (same rule the E2E suite follows — see tests/helpers.js).
 *
 * Usage:  node scripts/capture-showcase.js [--stills] [--video]
 * With no flags both passes run.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const ROOT = path.join(__dirname, '..', '..');
const IMG_DIR = path.join(ROOT, 'images');
const VIDEO_DIR = path.join(IMG_DIR, 'video');

const SEED = {
  password: 'Passw0rd!',
  admin: 'admin@b2boms.test',
  agent: 'agent@b2boms.test',
  customer: 'customer@b2boms.test',
};

const STILL_VIEWPORT = { width: 1440, height: 900 };
const VIDEO_VIEWPORT = { width: 1280, height: 800 };

/** Settle time after a client-side navigation, so async data is on screen. */
const SETTLE = 1100;

/**
 * Log in through the public /login form.
 *
 * The cold load of '/' first is deliberate: when a guard bounces a signed-out
 * visitor it pushes /login with `state.from`, and a goto() to that SAME url
 * keeps the session-history entry (i.e. the stale `from`). The next login would
 * then be redirected to the previous role's page and bounced again. Landing on
 * '/' first clears that state, and we wait for the user chip instead of a
 * specific route so any post-login redirect still counts as success.
 */
async function login(page, email) {
  await page.goto(`${BASE_URL}/`);
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', SEED.password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.user-chip', { timeout: 15000 });
  await page.waitForTimeout(400);
}

/** Click a sidebar link by its route (client-side nav keeps the live session). */
async function nav(page, href) {
  await page.click(`.sidebar a[href="${href}"]`);
  await page.waitForTimeout(SETTLE);
}

/** Log out from the sidebar footer (no-op when anonymous). */
async function logout(page) {
  const btn = page.locator('.sidebar__footer >> button:has-text("Log out")');
  if (await btn.count()) {
    await btn.click();
    await page.waitForSelector('.user-chip', { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(400);
  }
}

async function shot(page, file) {
  await page.screenshot({ path: path.join(IMG_DIR, file) });
  console.log(`  still -> ${path.relative(ROOT, path.join(IMG_DIR, file))}`);
}

/** Gentle scroll so the frame is not always pinned to the top of the page. */
async function scrollTour(page) {
  await page.mouse.wheel(0, 260);
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Pass 1 — desktop stills
// ---------------------------------------------------------------------------
async function captureStills() {
  console.log('Pass 1: stills @', `${STILL_VIEWPORT.width}x${STILL_VIEWPORT.height}`);
  const browser = await chromium.launch();
  try {
    // --- Anonymous: home page ------------------------------------------------
    let ctx = await browser.newContext({ viewport: STILL_VIEWPORT, baseURL: BASE_URL });
    let page = await ctx.newPage();
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector('.hero__title');
    await page.waitForTimeout(1500); // let the health probe resolve
    await shot(page, '15-home-page.png');
    await ctx.close();

    // --- Admin --------------------------------------------------------------
    ctx = await browser.newContext({ viewport: STILL_VIEWPORT, baseURL: BASE_URL });
    page = await ctx.newPage();
    await login(page, SEED.admin);
    await nav(page, '/dashboard');
    await page.waitForSelector('.statcard');
    await page.waitForTimeout(700);
    await shot(page, '16-admin-dashboard.png');
    await nav(page, '/admin/products');
    await page.waitForSelector('table.table, .table');
    await shot(page, '17-admin-products.png');
    await nav(page, '/inventory');
    await page.waitForSelector('table.table, .table');
    await shot(page, '18-admin-inventory.png');
    await nav(page, '/users');
    await page.waitForSelector('table.table, .table');
    await shot(page, '19-admin-users.png');
    await nav(page, '/audit');
    await page.waitForSelector('table.table, .table');
    await shot(page, '20-admin-audit-log.png');
    await ctx.close();

    // --- Order manager (agent) ----------------------------------------------
    ctx = await browser.newContext({ viewport: STILL_VIEWPORT, baseURL: BASE_URL });
    page = await ctx.newPage();
    await login(page, SEED.agent);
    await nav(page, '/dashboard');
    await page.waitForSelector('.statcard');
    await page.waitForTimeout(700);
    await shot(page, '21-agent-dashboard.png');
    await nav(page, '/orders/manage');
    await page.waitForSelector('table.table, .table, .page__title');
    await shot(page, '22-agent-order-processing.png');
    await ctx.close();

    // --- Customer -----------------------------------------------------------
    ctx = await browser.newContext({ viewport: STILL_VIEWPORT, baseURL: BASE_URL });
    page = await ctx.newPage();
    await login(page, SEED.customer);
    await nav(page, '/orders');
    await page.waitForSelector('.page__title');
    await shot(page, '23-customer-orders.png');

    // Put one line in the cart so the cart shot shows real content.
    await nav(page, '/products');
    const first = page.locator('.product-card a').first();
    await first.click();
    await page.waitForSelector('form[aria-label="add to cart form"]');
    await page.fill('input[name="quantity"]', '2');
    await page.click('form[aria-label="add to cart form"] button[type="submit"]');
    await page.waitForSelector('.add-to-cart__ok', { timeout: 10000 });
    await shot(page, '24-customer-product-detail.png');
    await nav(page, '/cart');
    await page.waitForSelector('.page__title');
    await shot(page, '25-customer-cart.png');

    // Prefer an ISSUED invoice for the still — a VOIDED one stamps the shot.
    await nav(page, '/invoices');
    await page.waitForSelector('.page__title');
    const issuedRow = page.locator('main tbody tr', { hasText: 'Issued' }).first();
    const invLink = (await issuedRow.count())
      ? issuedRow.locator('a').first()
      : page.locator('main a[href^="/invoices/"]').first();
    if (await invLink.count()) {
      await invLink.click();
      await page.waitForTimeout(SETTLE);
    }
    await shot(page, '26-customer-invoice.png');
    await ctx.close();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — MP4 walkthrough (one browser context = one continuous video)
// ---------------------------------------------------------------------------
async function captureVideo() {
  console.log('Pass 2: walkthrough @', `${VIDEO_VIEWPORT.width}x${VIDEO_VIEWPORT.height}`);
  fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch();
  let videoPath = null;
  try {
    const ctx = await browser.newContext({
      viewport: VIDEO_VIEWPORT,
      baseURL: BASE_URL,
      recordVideo: { dir: VIDEO_DIR, size: VIDEO_VIEWPORT },
    });
    const page = await ctx.newPage();

    // 1. Landing page
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector('.hero__title');
    await page.waitForTimeout(1800);
    await scrollTour(page);

    // 2. Catalog as a visitor, with a live search. The term is taken from the
    //    first real card (never hardcoded) so the result set cannot be empty.
    await page.click('.sidebar a[href="/products"]');
    await page.waitForSelector('.product-card');
    await page.waitForTimeout(1500);
    const nameText = (await page.locator('.product-card__name').first().textContent()) || '';
    const skuText = (await page.locator('.product-card__sku').first().textContent()) || '';
    const term = nameText.trim().split(/\s+/)[0] || skuText.trim();
    await page.fill('input[aria-label="Search products"]', term);
    await page.click('form.toolbar button[type="submit"]');
    await page.waitForTimeout(2200);
    if (!(await page.locator('.product-card').count())) {
      // Name did not match — retry on the SKU, which the API also searches.
      await page.fill('input[aria-label="Search products"]', skuText.trim());
      await page.click('form.toolbar button[type="submit"]');
      await page.waitForTimeout(2200);
    }
    await page.click('.product-card a');
    await page.waitForSelector('h1, .page__title');
    await page.waitForTimeout(1800);
    await page.goBack();
    await page.waitForTimeout(1200);

    // 3. Admin journey
    await logout(page);
    await login(page, SEED.admin);
    await page.click('.sidebar a[href="/dashboard"]');
    await page.waitForSelector('.statcard');
    await page.waitForTimeout(2600);
    await scrollTour(page);
    for (const href of ['/inventory', '/admin/products', '/audit', '/users']) {
      await page.click(`.sidebar a[href="${href}"]`);
      await page.waitForSelector('table.table, .table');
      await page.waitForTimeout(1900);
    }

    // 4. Order manager journey
    await logout(page);
    await login(page, SEED.agent);
    await page.click('.sidebar a[href="/dashboard"]');
    await page.waitForSelector('.statcard');
    await page.waitForTimeout(2400);
    await page.click('.sidebar a[href="/orders/manage"]');
    await page.waitForSelector('.page__title');
    await page.waitForTimeout(2200);
    await scrollTour(page);

    // 5. Customer journey: browse -> cart -> orders -> invoice
    await logout(page);
    await login(page, SEED.customer);
    await page.click('.sidebar a[href="/products"]');
    await page.waitForSelector('.product-card');
    await page.waitForTimeout(1600);
    await page.click('.product-card a');
    await page.waitForSelector('form[aria-label="add to cart form"]');
    await page.waitForTimeout(1200);
    await page.fill('input[name="quantity"]', '3');
    await page.click('form[aria-label="add to cart form"] button[type="submit"]');
    await page.waitForSelector('.add-to-cart__ok', { timeout: 10000 });
    await page.waitForTimeout(1400);
    await page.click('.sidebar a[href="/cart"]');
    await page.waitForSelector('.page__title');
    await page.waitForTimeout(2400);
    await page.click('.sidebar a[href="/orders"]');
    await page.waitForSelector('.page__title');
    await page.waitForTimeout(2200);
    // Scoped to <main> and excluding the staff "Orders" nav link, whose href
    // also starts with /orders/ — clicking that would bounce a customer to login.
    const orderLinks = page.locator('main a[href^="/orders/"]');
    if (await orderLinks.count()) {
      await orderLinks.first().click();
      await page.waitForTimeout(2000);
    }
    await page.click('.sidebar a[href="/invoices"]');
    await page.waitForSelector('.page__title');
    await page.waitForTimeout(1800);
    const inv = page.locator('main a[href^="/invoices/"]').first();
    if (await inv.count()) {
      await inv.click();
      await page.waitForTimeout(2600);
    }
    await logout(page);
    await page.waitForTimeout(1200);

    videoPath = await page.video().path();
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`  raw webm -> ${videoPath}`);
  return videoPath;
}

/** webm -> H.264 mp4 (LinkedIn accepts mp4/mov, not webm). */
async function convertToMp4(webmPath) {
  let ffmpeg;
  try {
    ffmpeg = require('ffmpeg-static');
  } catch {
    ffmpeg = null;
  }
  if (!ffmpeg) {
    console.warn('  ! ffmpeg-static not installed — leaving the clip as .webm');
    return webmPath;
  }
  const { spawnSync } = require('child_process');
  const out = path.join(VIDEO_DIR, 'b2b-oms-walkthrough.mp4');
  const args = [
    '-y',
    '-i',
    webmPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-r',
    '25',
    out,
  ];
  const res = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    console.warn('  ! mp4 conversion failed:', (res.stderr || '').slice(-500));
    return webmPath;
  }
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`  mp4 -> ${path.relative(ROOT, out)} (${mb} MB)`);
  return out;
}

(async () => {
  const flags = process.argv.slice(2);
  const only = flags.filter((f) => f.startsWith('--'));
  const doStills = only.length === 0 || only.includes('--stills');
  const doVideo = only.length === 0 || only.includes('--video');

  fs.mkdirSync(IMG_DIR, { recursive: true });

  // Fail fast with a clear message if the stack is not running.
  try {
    const res = await fetch(`${BASE_URL}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`Frontend not reachable at ${BASE_URL} (${e.message}).`);
    console.error('Start it first: npm run dev:backend  and  npm run dev:frontend');
    process.exit(1);
  }

  if (doStills) await captureStills();
  if (doVideo) {
    const webm = await captureVideo();
    await convertToMp4(webm);
  }
  console.log('Done.');
})().catch((e) => {
  console.error('Capture failed:', e);
  process.exit(1);
});
