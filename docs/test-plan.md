# Test Plan — B2B Order Management Platform

Last updated: 2026-10-23 (Phase 12). This document is the **strategy**;
[`docs/test-results.md`](test-results.md) records the **measured outcome** of the most
recent real execution, and `evidence/test-reports/` holds the raw console output every
number is derived from.

## 1. Purpose & scope

The platform is a simulated B2B order-management system (catalog, inventory, cart,
server-priced orders, invoicing, an append-only audit trail, role-scoped dashboards and
admin user management). Testing must prove three things without ever touching real money or
production data:

1. **Business correctness** — pricing, stock reservation/consumption/release, order
   transitions, invoice generation and financial immutability behave exactly as specified.
2. **Authorization** — every role (CUSTOMER, ORDER_MANAGER/agent, ADMIN, anonymous) can do
   precisely what it is allowed to do and nothing more; cross-customer access is denied
   without leaking existence.
3. **Reproducibility** — any developer can clone, start the database, and run every tier
   with one command, against isolated data, and get the same green result.

Out of scope: real payment processing, tax compliance and load/perf benchmarking (the
requirements explicitly exclude settlement — see §3.2 of `requirements.md`).

## 2. The test pyramid (four tiers + tooling)

| Tier | Tooling | Location | Needs DB? | What it proves |
|---|---|---|---|---|
| **Unit** | Node.js built-in test runner (`node:test`) | `backend/tests/*-unit.test.js`, `unit.test.js` | No | Pure logic: validation, integer-cent pricing, order-transition rules, error envelope, money rounding, audit registry |
| **Integration / REST** | `node:test` + **Supertest** + **PostgreSQL** | `backend/tests/*-http.test.js`, `app.test.js`, `db-integration.test.js` | **Yes** (`b2b_oms_test`) | Every REST route, transactions, DB invariants (FK/CHECK/UNIQUE, generated column, append-only trigger), idempotency, concurrency, migration reversibility, RBAC per role |
| **Frontend component** | **Vitest** + **React Testing Library** (jsdom) | `frontend/src/test/*.test.jsx` | No | Forms, loading/empty/error boundaries, navigation, role-aware UI, server-driven money, optimistic↔authoritative state |
| **End-to-end** | **Playwright** (Chromium) | `e2e/tests/*.spec.js` | **Yes** (`b2b_oms_e2e`) | The full stack through the real browser: the 10 critical journeys and the negative/adversarial paths |

Unit/integration use the Node test runner already shipped since Phase 3; the frontend and
Playwright tiers build on Vitest/RTL and the newly added `@playwright/test`. All tiers are
driven by the **same public surface** (REST + rendered DOM), never by reaching into module
internals, so a passing suite means the product works, not just that the code moved.

## 3. Database safety (the hard rule)

> **Never use a production database for tests. Do not let tests delete or reset a database
> unless it is explicitly configured as an isolated disposable test database.**

Three databases, structurally separated by name and by connection string:

| Database | Purpose | Reset policy |
|---|---|---|
| `b2b_oms` | human development | **never** touched by any test |
| `b2b_oms_test` | integration + backend coverage | migrate-only (idempotent, never drops); a dedicated reversibility test does `down --all`/`up` inside the isolated DB |
| `b2b_oms_e2e` | Playwright E2E | **disposable** — fully recreated (DROP `WITH (FORCE)` → CREATE → migrate → seed) on every run |

Enforcement:

- `node:test`/Supertest connect via `DATABASE_URL_TEST` **only** when `NODE_ENV=test`;
  the `run-integration-tests.js` and `run-coverage.js` runners **abort with guidance** if
  `DATABASE_URL_TEST` is unset, so a test run can never silently fall back to `DATABASE_URL`.
- The E2E bootstrap (`backend/scripts/db/bootstrap-e2e.js`) is **guarded by name**: it
  refuses to drop/reset anything whose database name does not match `/^[a-z0-9_]*_e2e$/i`.
  Pointing it at `b2b_oms` (or any non-`*_e2e` name) is rejected before a connection is made.
- Playwright's `webServer` launches the API with `DATABASE_URL` overridden to `b2b_oms_e2e`,
  and `reuseExistingServer:false` so it never reuses a stray dev server bound to `b2b_oms`.
- Browser E2E authenticates through the UI and holds the access token **in memory**; a
  stray running dev backend cannot hijack an E2E session because E2E spins up its own.

## 4. What each tier covers

### 4.1 Unit (backend)
- **Validation** — request schema coercion/rejection (`validators.js`), quantity bounds,
  positive ids, enum closure, pagination clamps.
- **Pricing** — integer-cent math, `unit × qty` line totals, tax rounding, `grand = subtotal
  + tax` (never float), snapshot vs. live price.
- **Order transitions** — the pending → confirmed → processing → shipped → delivered chain,
  cancellation only pre-ship, illegal jumps rejected, stock reservation/consumption/release
  accounting.
- **Business rules** — idempotency key/hash semantics, invoice numbering, RBAC matrix,
  error envelope `{ error: { code, message } }`.

### 4.2 Integration / REST (backend + PostgreSQL)
- CRUD + auth flows for **every** resource (catalog, inventory, cart, orders, invoices,
  audit, reports, users) over Supertest.
- **Transactions & invariants** — multi-statement atomicity, oversell races (20-way),
  shortfall rollback leaves no order and no stock movement, DB CHECK/UNIQUE/FK enforcement,
  generated `available_quantity`, append-only `audit_logs` trigger, snapshot immutability,
  migration reversibility (`down --all` then `up`).
- **Authorization for every role** — anonymous `401`, CUSTOMER self-scope, foreign-resource
  `404` (never `403`, to avoid existence leaks), staff `403`/`200`, ADMIN-only reads/writes,
  disabled-account rejection, refresh-token rotation + reuse revocation, login rate-limit
  `429`.

### 4.3 Frontend (Vitest + RTL)
- Forms (login, register, add-product, stock adjust, cart, checkout, cancel, void) — inputs,
  client-side gating, submission states.
- Errors (validation surfacing, server-error display), **loading** and empty boundaries.
- Navigation & route guards (`RequireRole`), token-refresh-on-`401`, silent session
  rehydration, role-aware rendering (the agent gets no audit feed).

### 4.4 End-to-end (Playwright) — the ten critical journeys
1. Admin logs in and creates a product.
2. Admin updates stock.
3. Customer registers, then logs in.
4. Customer browses products and adds one to the cart.
5. Customer places an order (server-priced, stock reserved).
6. Stock reservation is verified on the inventory ledger.
7. Order manager processes the order through to shipment (invoice minted).
8. Customer views the order and its generated invoice.
9. Admin views audit events and dashboard statistics.
10. A customer is denied another customer's order and invoice.

Plus the negative/adversarial suite (executed against the authoritative API): insufficient
stock, invalid quantities, inactive products, atomic DB rollback, duplicate/idempotent
requests, unauthorized actions, and disabled-account login.

**E2E navigation rule:** protected screens are reached by clicking (navbar / row / "View
invoice"), not by a cold `page.goto`, because the access token is memory-only and a reload
would race cookie rehydration. Public routes (`/products`, `/login`, `/register`) may use a
cold goto. This keeps journeys deterministic and faithful to real user behavior.

## 5. Commands

| Command | Runs | Database |
|---|---|---|
| `npm run install:all` | deps for root + backend + frontend + e2e (then `npx playwright install chromium`) | — |
| `docker compose up -d db` | start PostgreSQL 16 on host `:5433` | — |
| `npm test` | backend `node:test` (unit; DB tests auto-skip) + frontend Vitest | none |
| `npm run test:integration` | backend DB + REST suites (migrates `b2b_oms_test` first) | `b2b_oms_test` |
| `npm run test:e2e` | Playwright — boots API + SPA, recreates the disposable DB, runs 17 tests | `b2b_oms_e2e` |
| `npm run e2e:bootstrap` | recreate the disposable E2E DB only (guarded) | `b2b_oms_e2e` |
| `npm run test:all` | `test` + `test:integration` + `test:e2e` | as above |
| `npm run coverage:backend` | full backend suite under V8 coverage | `b2b_oms_test` |
| `npm run coverage:frontend` | Vitest under v8 coverage | none |
| `npm run coverage` | both coverage runs | — |
| `npm run lint` / `npm run format:check` | ESLint (both packages) / Prettier | none |

## 6. Coverage policy

Coverage is **measured and reported, never gated.** No `thresholds` block is set on either
the backend (`--experimental-test-coverage`) or the frontend (`vite.config.js → coverage`).
Rationale (task constraint): an arbitrary pass/fail percentage lets the build go green while
untested branches are hidden behind a lucky average; instead the raw per-file table is kept
visible so real gaps (e.g. thin unit coverage of pages that are covered by E2E) stay a
honest follow-up signal. Coverage is a diagnostic, not a target.

## 7. Evidence generation

`evidence/test-reports/` files are produced **only** from commands actually executed. Each
Phase 12 artifact is timestamped and paired with its raw output:

| Artifact | Source command |
|---|---|
| `phase12-e2e-raw.txt` + `phase12-e2e-report.json` | `npm run test:e2e` |
| `phase12-backend-integration-raw.txt` | `npm run test:integration` |
| `phase12-backend-coverage-raw.txt` | `npm run coverage:backend` |
| `phase12-frontend-coverage-raw.txt` | `npm run coverage:frontend` |
| `phase12-frontend-npm-audit.txt`, `phase12-e2e-npm-audit.txt` | `npm ... audit` (+ `--omit=dev`) |
| `phase12-e2e-and-test-automation.md` | the narrative assembled from the above |

Known/benign noise is recorded rather than scrubbed (e.g. the expected `pg.pool.error …
administrator command` line emitted when the guarded bootstrap drops the disposable DB
before the tests). Current pass/fail is in [`docs/test-results.md`](test-results.md).
