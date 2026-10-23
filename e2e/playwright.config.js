'use strict';

const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const { DATABASE_URL_E2E, API_URL, BASE_URL } = require('./e2e-env');

/**
 * Playwright config — Phase 12 browser E2E.
 *
 * Isolation model (docs/test-plan.md §"Database safety"):
 *  - globalSetup provisions a FRESH, disposable `b2b_oms_e2e` database (guarded,
 *    never dev/prod).
 *  - The API webServer is launched with DATABASE_URL overridden to that same
 *    *_e2e database, so every browser action mutates only disposable data.
 *  - Tests run SERIALLY against that one database (workers=1, fullyParallel=false)
 *    because they share seeded catalog/inventory state; serial execution keeps
 *    stock-reservation and lifecycle assertions deterministic.
 */
module.exports = defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup'),
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node src/server.js',
      cwd: path.join(__dirname, '..', 'backend'),
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        NODE_ENV: 'development',
        PORT: String(new URL(API_URL).port || 4000),
        // Point the API at the disposable E2E database, never dev/prod.
        DATABASE_URL: DATABASE_URL_E2E,
        CORS_ORIGINS: BASE_URL,
        COOKIE_SECURE: 'false',
        // Generous limits so many browser logins/registrations in one run never
        // trip the per-IP auth buckets (rate limiting itself is covered by the
        // backend integration suite, which enforces the real thresholds).
        AUTH_RATE_MAX: '1000',
        REGISTER_RATE_MAX: '1000',
      },
    },
    {
      command: 'npm run dev',
      cwd: path.join(__dirname, '..', 'frontend'),
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        VITE_BACKEND_ORIGIN: API_URL,
        VITE_API_BASE_URL: '',
      },
    },
  ],
});
