# Phase 12 — QA & Test Automation: test evidence

Date: 2026-10-23 (IST). Environment: Windows, Node **v24.17.0**, PostgreSQL 16 (Docker,
host port **5433**), backend CommonJS/Express, frontend React 18 + Vite. Chromium
(Playwright-managed).

Phase 12 added the one missing test tier — **browser end-to-end automation** — and a
reproducible **coverage** path for the backend and frontend. No application code, schema,
migration or dependency version was changed. The new Playwright suite lives in the
`e2e/` workspace and runs the ten critical business journeys plus a negative/adversarial
suite against a **disposable, guarded `b2b_oms_e2e` database**.

> **Every number and table in this file was produced by a command actually executed this
> session.** The raw console output is captured alongside as `phase12-*-raw.txt` and
> `phase12-e2e-report.json`. Nothing here is extrapolated from an earlier phase.

---

## 1. Commands added (and how to reproduce each number)

| Suite | Command | DB touched |
|---|---|---|
| Playwright E2E (10 journeys + 7 negative) | `npm run test:e2e` | disposable `b2b_oms_e2e` (auto-recreated by `globalSetup`) |
| E2E DB bootstrap only | `npm run e2e:bootstrap` | `b2b_oms_e2e` (guarded reset) |
| Backend unit + REST + DB integration | `npm run test:integration` | isolated `b2b_oms_test` (never dev/prod) |
| Backend coverage (whole suite, V8) | `npm run coverage:backend` | isolated `b2b_oms_test` |
| Frontend coverage (Vitest + RTL, v8) | `npm run coverage:frontend` | none (jsdom) |
| Everything | `npm run test:all` | per-suite as above |

`npm run test:e2e` boots the API and the Vite SPA itself (Playwright `webServer`,
`reuseExistingServer:false`), so it never reuses a stray dev server. The API process is
launched with `DATABASE_URL` **overridden to `b2b_oms_e2e`**, so no browser action can
reach development data.

---

## 2. Database-safety proof (hard constraint)

- The disposable reset (`backend/scripts/db/bootstrap-e2e.js`) accepts a target **only**
  when its name matches `/^[a-z0-9_]*_e2e$/i`. Verified this session: pointing it at the
  development database `b2b_oms` is **refused** — nothing is dropped.
- `globalSetup` recreated `b2b_oms_e2e` (DROP … WITH (FORCE) → CREATE → migrate → seed),
  logged as: `Recreated disposable E2E database "b2b_oms_e2e"` and
  `Seeded 4 users and 6 products into "b2b_oms_e2e"` — see `phase12-e2e-raw.txt` lines 3–7.
- Integration + coverage runs require `DATABASE_URL_TEST` and abort with a guidance message
  if it is unset; they connect to `b2b_oms_test`, never `DATABASE_URL`.
- One benign, expected log line appears in the E2E capture:
  `{"level":"error","message":"pg.pool.error","detail":"terminating connection due to
  administrator command"}`. This is the pooled connection being cut when the guarded
  bootstrap DROPs the disposable database **before any test starts** — it is not a test
  failure (all 17 tests still pass) and is recorded here so the evidence stays honest.

---

## 3. Playwright end-to-end suite — **17 passed / 0 failed / 0 skipped / 0 flaky**

Command: `node @playwright/test/cli.js test` (via `npm run test:e2e`).
Run start `2026-10-23T12:58:00Z` (18:28 IST), duration **50.4 s**, exit code 0.
Raw: `phase12-e2e-raw.txt`; machine-readable: `phase12-e2e-report.json`.

### 3.1 The ten critical business journeys (real Chromium, real SPA, real API)

| # | Journey | Time | Result |
|---|---|---|---|
| 1 | Admin logs in and creates a product | 4.6 s | PASS |
| 2 | Admin updates stock (GADGET-B +5 adjustment) | 2.2 s | PASS |
| 3 | Customer registers, then logs in | 2.8 s | PASS |
| 4 | Customer browses products and adds one to the cart | 2.8 s | PASS |
| 5 | Customer places an order (server-priced, stock reserved) | 2.4 s | PASS |
| 6 | Stock reservation is verified on the inventory ledger | 2.0 s | PASS |
| 7 | Order manager processes the order through to shipment (invoice minted) | 2.1 s | PASS |
| 8 | Customer views the order and its generated invoice | 2.6 s | PASS |
| 9 | Admin views audit events and dashboard statistics | 2.1 s | PASS |
| 10 | A customer is denied another customer's order and invoice | 3.6 s | PASS |

Journeys run in a single serial worker sharing one narrative (`flow`) but each logs in
fresh. Protected screens are reached by **client-side navigation** (navbar / row / "View
invoice" clicks), never a cold reload — because the access token is held in memory only and
a full reload would race the refresh-cookie rehydration. Journey 8 was the regression that
drove this design: an earlier cold-`goto` version intermittently bounced to `/login`; the
SPA-click navigation is deterministic and mirrors what a real user does. Journey 10 is
deliberately race-immune: whether the guard bounces the intruder to login **or** the
ownership-scoped server returns `404`, the assertion is that none of the victim's email or
invoice number is ever rendered.

### 3.2 Negative & adversarial paths (authoritative, via the REST request fixture)

| Path | Expectation | Time | Result |
|---|---|---|---|
| Insufficient stock | `409 INSUFFICIENT_STOCK`, cart not mutated | 125 ms | PASS |
| Invalid quantities (`0`, `-5`, `2.5`) | `400 VALIDATION_ERROR` | 249 ms | PASS |
| Inactive product (LEGACY-01) | `404 PRODUCT_NOT_FOUND` | 89 ms | PASS |
| Failing multi-line order | `409`, **atomic rollback** — no order row, both products' stock unchanged, order count unchanged | 224 ms | PASS |
| Duplicate request (same UUID `Idempotency-Key`) | first `201`, replay `200 idempotent:true` same id; different body same key → `409 IDEMPOTENCY_CONFLICT` | 136 ms | PASS |
| Unauthorized actions | anon `401`, customer staff-PATCH `403`, customer audit read `403`, agent product write `403` | 80 ms | PASS |
| Disabled account login | `403 ACCOUNT_DISABLED`, no token | 148 ms | PASS |

These drive the SAME REST endpoints the SPA uses, with a Bearer token, so the server's real
validation/stock/idempotency/RBAC is asserted — the browser UI cannot be tricked into
accepting what the API rejects.

---

## 4. Backend — **228 passed / 39 suites / 0 fail / 0 skipped** with coverage

Command: `npm run coverage:backend` (added `backend/scripts/db/run-coverage.js`). It mirrors
`run-integration-tests.js`: requires `DATABASE_URL_TEST`, migrates it, then
`node --test --experimental-test-coverage --test-concurrency=1` with `B2B_RUN_DB_TESTS=1` so
the REST + PostgreSQL files actually execute (a plain `node --test` would *skip* them and
report a misleadingly low number). Duration 38.3 s. Raw: `phase12-backend-coverage-raw.txt`.

| Metric | Value |
|---|---|
| tests / suites | 228 / 39 |
| pass / fail / cancelled / skipped | 228 / 0 / 0 / 0 |
| **lines** | **96.34 %** |
| **branches** | **87.57 %** |
| **functions** | **92.63 %** |

Per-module lines coverage (from the raw table): controllers ≈ 96–100 %, routes 100 %,
services 92–100 %, repositories 83–100 %, middleware (authorize 100 %, authenticate 94.5 %,
rateLimit 100 %, errorHandler 87 %), utils (validators 100 %, money 98.3 %). The lowest
lines are **deliberate, non-reachable** paths — `requestLogger.js` (43 %, disabled unless
`REQ_LOG=1`), `logger.js` debug branches, and CLI/defensive `config/env` guards — not
missing tests of business logic.

The dedicated integration run (`npm run test:integration`, the 11 DB-backed files) was also
re-executed this session: **133 tests / 11 suites / 0 fail / 0 skipped** (raw:
`phase12-backend-integration-raw.txt`), confirming the Phase 3–11 guarantees are
unregressed on the current tree.

## 5. Frontend — **74 passed / 8 files** with coverage

Command: `npm run coverage:frontend` (Vitest + React Testing Library, `@vitest/coverage-v8`,
provider v8, reporters text/html/lcov). Duration 21.63 s. Raw:
`phase12-frontend-coverage-raw.txt`. No jsdom database is touched.

| Metric | Value |
|---|---|
| Test files / tests | 8 / 74 (all pass) |
| **% Stmts / % Lines** | **87.76 / 87.76** |
| **% Branch** | **76.82** |
| **% Functions** | **75.40** |

Strongest coverage is the app shell and shared code (`src/` aggregate 100 %; App.jsx 100 %;
hooks `useApi`/`useHealth` 100 %; `services/api.js` 92.85 %; components 96.45 %). The
explicitly low files are **`LoginPage.jsx` 5.63 %** and **`UsersPage.jsx` 6.01 %** — both
are exercised by the Playwright E2E journeys (admin/user flows) rather than by a dedicated
unit render, and **`utils/uuid.js` 44 %** (its crypto-less fallback branch). These are real,
reported gaps, not thresholds being padded.

---

## 6. Coverage policy (no arbitrary thresholds)

Per the task constraint, **no coverage threshold is configured to fail the build.** Backend
and frontend both report coverage but never gate on a percentage — an enforced floor would
let the number go "green" while hiding untested branches. Low spots are surfaced in §4/§5
and are the actual follow-up signal instead. The Vite coverage block
(`frontend/vite.config.js → test.coverage`) sets `all: true`, `include: src/**`, and
deliberately omits `thresholds`.

---

## 7. Dependency-audit state after Phase 12 (honest disclosure)

Phase 12 added two dev-only test tools: `@playwright/test` (new `e2e/` workspace) and
`@vitest/coverage-v8` (frontend devDependency). Audit run this session:

| Workspace | Full tree | Production (`--omit=dev`) | Raw |
|---|---|---|---|
| e2e | **0 vulnerabilities** | 0 vulnerabilities | `phase12-e2e-npm-audit.txt` |
| frontend | **4** (2 moderate, 2 critical) | **0 vulnerabilities** | `phase12-frontend-npm-audit.txt` |

All four frontend findings sit in the **`vitest → @vitest/mocker + tinypool`** chain
(the same advisories accepted in **D-27**); `@vitest/coverage-v8` merely depends on
`vitest`, so it adds a node to that chain, not a new family. They are **devDependencies**
that run only in the local test harness and are **never bundled into `dist/`** — proven by
`--omit=dev` = 0. The only "fix" is `vitest@5` (a breaking major with zero production
benefit), so this stays **accepted** under the D-27 rationale (re-review trigger: a
non-breaking patch, or real production deployment). Playwright pulls **no** vulnerable
transitives.

---

## 8. Known failures / limitations

- **0 failing tests across all three tiers this session** (17 E2E, 228 backend, 74 frontend).
- The `pg.pool.error … administrator command` line in the E2E capture is expected and
  benign (§2) — a pool connection severed by the guarded disposable-DB recreate before tests.
- Frontend `LoginPage.jsx` / `UsersPage.jsx` unit coverage is intentionally thin (§5): those
  flows are covered by real browser journeys, not component units. Tracked as the honest
  follow-up, not hidden by a threshold.
- E2E runs against a **simulated** seeded catalog (WIDGET-01/LEGACY-01/GADGET-B…), not any
  production dataset; the whole tier is structurally incapable of touching dev/prod (§2).
