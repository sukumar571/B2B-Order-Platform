# Requirements Traceability — B2B Order Management Platform

**Purpose:** map every requirement in [`requirements.md`](requirements.md) to the code that
implements it, the acceptance criteria in [`acceptance-criteria.md`](acceptance-criteria.md),
and the **real** evidence that verifies it (in [`test-results.md`](test-results.md) and
[`../evidence/test-reports/`](../evidence/test-reports/)).

**Verification tiers actually executed** (see `test-results.md` for provenance):

| Tier | Command | Real result |
|---|---|---|
| Backend unit + REST + DB integration (+ coverage) | `npm run coverage:backend` | **228 / 228 pass**, 96.34 % lines |
| DB integration subset | `npm run test:integration` | **133 / 133 pass** |
| Frontend component (Vitest + RTL) | `npm run coverage:frontend` | **74 / 74 pass**, 87.76 % lines |
| Browser end-to-end (Playwright) | `npm run test:e2e` | **17 / 17 pass** (10 journeys + 7 negative) |
| Deployed-stack smoke | `npm run docker:smoke` | **9 / 9 pass** (Phase 13) |

Status legend: **✅ Verified** = an automated test in the table above exercises it · **🟡 Partial**
= automated coverage exists but a documented manual/non-automated element remains · **⚪ Not
measured** = intentionally **not** run in this environment; reported honestly, never claimed as passing.

> **Honesty rule:** no row is marked ✅ unless a test that actually ran covers it. Performance
> latency under load is now **measured** by the 20-virtual-user benchmark (`backend/scripts/load/`,
> evidence in `evidence/test-reports/perf-load.md`); pilot-user timing (SC-06) remains **⚪ Not measured** (§5).

---

## 1. Functional requirements → implementation → evidence

### 1.1 Authentication & Users (AUTH)

| Req | Implemented in | Acceptance | Verified by (real) | Status |
|---|---|---|---|---|
| FR-AUTH-01 login issues JWT+profile | `services/auth.service.js`, `routes/auth.routes.js` | AC-AUTH-01 | integration auth suite; E2E journeys 1,3 | ✅ |
| FR-AUTH-02 uniform `401 INVALID_CREDENTIALS` | `auth.service.js` (constant-time compare) | AC-AUTH-02 | auth integration tests | ✅ |
| FR-AUTH-03 bcrypt-only, never returned/logged | `auth.service.js` (`bcryptjs` cost 12), `middleware/requestLogger.js` redaction | AC-AUTH-03 | auth unit + log-grep; `money`/redaction units | ✅ |
| FR-AUTH-04 missing/expired/malformed → `401` | `middleware/authenticate.js`, `services/token.service.js` | AC-AUTH-04 | auth integration (bad/expired/wrong-secret) | ✅ |
| FR-AUTH-05 admin creates staff/customer, unique email | `services/user.service.js`, `routes/user.routes.js` | AC-AUTH-05 | integration (duplicate email 409, login after create) | ✅ |
| FR-AUTH-06 deactivated users blocked, tokens rejected | `authenticate.js` per-request user re-load | AC-AUTH-06 | integration + E2E negative "disabled account 403" | ✅ |
| FR-AUTH-07 `GET /api/auth/me` | `auth.routes.js` | AC-AUTH-01/07 | integration; E2E journey 3 | ✅ |
| FR-AUTH-07a public CUSTOMER-only register | `auth.service.js` (forces role=customer) | — | integration register tests; E2E journey 3 | ✅ |

### 1.2 Products & Inventory (CAT)

| Req | Implemented in | Acceptance | Verified by (real) | Status |
|---|---|---|---|---|
| FR-CAT-01 create product (name/SKU/price>0/tax 0–100/active) | `product.service.js`, `validators.js` (Zod) | AC-CAT-01/02 | catalog integration; frontend `AdminProductsPage` | ✅ |
| FR-CAT-02 update + soft-deactivate, retain referenced | `product.service.js` (`is_active:false`) | AC-CAT-06 | integration (archive), E2E journey 1 | ✅ |
| FR-CAT-03 duplicate SKU → `409 DUPLICATE_SKU` | DB unique index + service pre-check | AC-CAT-03 | integration duplicate-SKU | ✅ |
| FR-CAT-04 list with pagination + search + `available_stock` | `product.repository.js`, `GET /api/products` | AC-CAT-07 | catalog integration (page/limit/offset) | ✅ |
| FR-CAT-05 single product by ID | `GET /api/products/:id` | AC-CAT-01 | integration; E2E journey 4 | ✅ |
| FR-CAT-06 inventory adjust (signed delta + reason + ledger + audit) | `inventory.service.js`, `inventory_movements` | AC-CAT-04 | integration stock-adjust; E2E journey 2 | ✅ |
| FR-CAT-07 never negative on-hand → `409 INSUFFICIENT_STOCK` | row lock `FOR UPDATE` + DB `CHECK` | AC-CAT-05 | integration negative-guard | ✅ |
| FR-CAT-08 inactive hidden + not addable to cart | `optionalAuthenticate` force-filter; cart add check | AC-CAT-06 | integration; E2E negative "inactive product 404" | ✅ |

### 1.3 Cart (CART)

| Req | Implemented in | Acceptance | Verified by (real) | Status |
|---|---|---|---|---|
| FR-CART-01 one cart/customer, add merges qty | `cart.service.js` (`cart_items` upsert) | AC-CART-01 | cart integration | ✅ |
| FR-CART-02 reject inactive product / qty < 1 | `validators.js`, cart service | AC-CART-04 | integration; E2E negative qty 0/-5/2.5 | ✅ |
| FR-CART-03 server-side line/subtotal/tax/grand totals | `utils/money.js` (decimal-safe) | AC-CART-02 | cart integration `19.99×3 @7.5%` fixture; money unit | ✅ |
| FR-CART-04 availability warning, no reservation at cart time | `cart.service.js` `available_now` | AC-CART-03 | integration (stock unchanged after cart) | ✅ |
| FR-CART-05 empty cart + auto-clear on order | `cart.service.js`, `order.service.js` | AC-ORD-01 | integration; E2E journey 5 | ✅ |

### 1.4 Orders (ORD)

| Req | Implemented in | Acceptance | Verified by (real) | Status |
|---|---|---|---|---|
| FR-ORD-01 create from cart, re-read prices/stock server-side | `order.service.js` | AC-ORD-03 | integration; E2E journey 5 | ✅ |
| FR-ORD-02 single txn, `SELECT … FOR UPDATE`, reserve, atomic rollback | `order.service.js` + `order.repository.js` | AC-ORD-02 | integration atomicity; E2E negative rollback | ✅ |
| FR-ORD-03 insufficient line → `409`, all stock unchanged | DB transaction + CHECK | AC-ORD-02 | integration; E2E "failing multi-line order" | ✅ |
| FR-ORD-04 snapshot name/price in `order_items` | migration `order_items` columns; service snapshot | AC-ORD-06 | integration snapshot-immutability | ✅ |
| FR-ORD-05 server-side decimal totals | `money.js`, stored `NUMERIC` | AC-ORD-01/AC-INV-01 | money unit + integration invariant | ✅ |
| FR-ORD-06 `Idempotency-Key` required, replay returns original | `middleware`/`order.service.js`, `idempotency_keys` | AC-ORD-04/07 | integration idempotent-replay + conflict; E2E negative | ✅ |
| FR-ORD-07 status machine `pending→confirmed→fulfilled`, `cancelled` terminal | `order.service.js` state guard | AC-LIF-01/02/03/06 | integration lifecycle matrix | ✅ |
| FR-ORD-08 cancel own/any, release stock in txn | `POST /api/orders/:id/cancel` | AC-LIF-04 | integration ship-consume/cancel-release; E2E | ✅ |
| FR-ORD-09 only staff confirm/fulfil, fulfil→invoice atomic | `authorize('ADMIN','ORDER_MANAGER')` | AC-LIF-01/AC-INV-01 | integration; E2E journey 7 | ✅ |
| FR-ORD-10 invalid transition → `409 INVALID_STATE_TRANSITION` | state machine guard | AC-LIF-02/03/06 | integration lifecycle | ✅ |
| FR-ORD-11 list/filter; customers own only; foreign → `404` | `requireOwnership`/`requireSelf` | AC-LIF-05 | integration ownership; E2E journey 10 | ✅ |

### 1.5 Invoices (INV)

| Req | Implemented in | Acceptance | Verified by (real) | Status |
|---|---|---|---|---|
| FR-INV-01 invoice from snapshot on fulfilment | `invoice.service.js` (in fulfilment txn) | AC-INV-01 | integration; E2E journey 7/8 | ✅ |
| FR-INV-02 gap-tolerant sequential number, atomic | `invoice_counters`, `INV-YYYY-NNNNNN` | AC-INV-02 | integration numbering | ✅ |
| FR-INV-03 invoice totals == order totals | `money.js` reuse | AC-INV-01 | integration equality assert | ✅ |
| FR-INV-04 role scoping (customer own / staff all) | scoping in `invoice.service.js` | AC-INV-04 | integration; E2E journey 8 | ✅ |
| FR-INV-05 at most one invoice per order (DB unique) | `invoices.order_id` unique | AC-INV-03 | integration duplicate-invoice | ✅ |

### 1.6 Audit & Observability (AUD)

| Req | Implemented in | Acceptance | Verified by (real) | Status |
|---|---|---|---|---|
| FR-AUD-01 audit every listed event | `audit.service.js` inside same txn | AC-AUD-01 | integration audit-completeness matrix; E2E journey 9 | ✅ |
| FR-AUD-02 append-only (no update/delete route) | `audit_logs` append-only trigger | AC-AUD-03 | integration append-only; DB trigger test | ✅ |
| FR-AUD-03 admin query by actor/action/entity/date | `report.service.js`, `GET /api/audit-logs` | AC-AUD-03 | integration filters; frontend `AuditLogsPage` | ✅ |
| FR-AUD-04 health endpoint (service + db) | `health.service.js`, `GET /api/health` `/health` | AC-DEPLOY-01 | Phase 13 smoke (9/9); docker healthchecks | ✅ |
| FR-AUD-05 never log/audit secrets | `requestLogger.js` redaction | AC-AUD-02 | auth unit log-grep; AC-AUD-02 | ✅ |

---

## 2. Non-functional requirements

| Req | Where satisfied | Evidence | Status |
|---|---|---|---|
| NFR-01 credentials never returned/logged/stored | `auth.service.js`, redaction, transient form state | AC-AUTH-03 + integration + Phase 13 cookie-flags smoke | ✅ |
| NFR-02 SQL injection (all parameterized) | every `*.repository.js` (parameterized SQL only) | integration hostile-input suite (NFR-SEC-01) | ✅ |
| NFR-03 secrets from env only | `.env.example` placeholders; root `.env` git-ignored; `${VAR:?}` | Phase 13 fail-fast + image `.env count:0` | ✅ |
| NFR-04 RBAC on 100 % endpoints | `authorize.js` per route | integration per-role forbidden cases | ✅ |
| NFR-05 performance p95 targets | layered + indexes; `pg` pool | 20-vU closed-loop benchmark (`perf-run.js`): reads p95 **118 ms**, order p95 **501 ms**, 0× 5xx | ✅ measured |
| NFR-06 order atomicity | transactional order create | integration rollback + E2e negative | ✅ |
| NFR-07 decimal-safe money | `utils/money.js`, `NUMERIC` | money unit + total invariants | ✅ |
| NFR-08 core flows ≤ 5 UI steps | SPA UX | E2E journeys demonstrate; **not step-counted** | 🟡 |
| NFR-09 Chrome/Edge ≥1280px | responsive CSS | Playwright **Chromium** only; Edge not separately run | 🟡 |
| NFR-10 layered, ESLint clean, no file > ~400 lines | `architecture.md` layers | `npm run lint` exit 0 (both workspaces) | ✅ |
| NFR-11 integration covers endpoints + FR-ORD; ≥80 % order/inventory/pricing | `services/` modules | 228/133 backend, services 92–100 % lines | ✅ |
| NFR-12 `docker compose up` migrates+healthy in 60 s | `docker-compose.yml` | Phase 13 clean deploy (db→migrate→backend→frontend healthy) | ✅ |
| NFR-13 every state change reconstructible | `audit_logs` + snapshots | integration audit completeness | ✅ |
| NFR-14 `pg_dump`/restore + named volume survives | `deployment.md` §6–7, `pgdata` | Phase 13 backup→restore identical counts; restart persistence | ✅ |

---

## 3. Constraints (C-01 … C-10)

| Constraint | Satisfied by | Status |
|---|---|---|
| C-01 React + Vite JS only | `frontend/` (no TS) | ✅ |
| C-02 Express layered routes→…→repositories | `backend/src/` layout | ✅ |
| C-03 PostgreSQL + node-pg-migrate, `NUMERIC` money | `migrations/` (18), money columns | ✅ |
| C-04 Zod at boundary, parameterized SQL | `validators.js`, repositories | ✅ |
| C-05 JWT + bcrypt, server RBAC | `token.service.js`, `authorize.js` | ✅ |
| C-06 secrets via env only | fail-fast `.env` policy | ✅ |
| C-07 Dockerfile + compose (API + PG) | `docker-compose.yml` (+dev) | ✅ |
| C-08 Node+Supertest / Vitest+RTL / Playwright | test tiers §0 | ✅ |
| C-09 Windows + WSL2/Docker | Phase 13 ran on Windows host | ✅ |
| C-10 single tenant | no tenant column/scoping | ✅ (by design) |

---

## 4. Out-of-scope & deferred (from requirements §3.2) — delivered anyway or intentionally excluded

| Item | Status |
|---|---|
| Reporting dashboards / BI, CSV export | **Delivered** in Phase 9 (`GET /api/reports/*`, `DashboardPage`) beyond original scope; CSV export **not** built |
| Audit-log viewer (ADMIN) | Delivered Phase 9 |
| Customer self-registration | Delivered Phase 10 (forced CUSTOMER role) — reverses the original "admin only" exclusion |
| Online payment, shipping, multi-warehouse, discounts/price-lists, taxes beyond one %, localization, mobile-native | **Excluded** as designed — see [`limitations.md`](limitations.md) / [`future-roadmap.md`](future-roadmap.md) |

---

## 5. Success criteria — honest status

| SC | Definition | Real status |
|---|---|---|
| SC-01 | 100 % of Must-Have AC pass | ✅ every Must AC maps to a passing test tier above |
| SC-02 | 20-way oversell → exactly 5 succeed, 15 clean 409, no negative | ✅ covered by the **20-way oversell race** integration test (functional correctness, run serially) |
| SC-03 | duplicate idempotency key → exactly one order, 100/100 | ✅ integration idempotent-replay + conflict |
| SC-04 | post-order price/name edit never changes history | ✅ integration snapshot-immutability |
| SC-05 | Playwright happy path green | ✅ E2E journeys 1→9 |
| SC-06 | pilot user places an order in ≤ 10 min training | ⚪ **Not performed** — no pilot users available; qualitative, not measured |
| SC-07 | NFR-05 latency targets met in a load test | ✅ **Measured PASS** — 20-vU closed-loop benchmark (60 s reads + 60 s order creation) on 500 products/200 customers: reads p95 118 ms (≤ 500), order p95 501 ms (≤ 1500), 5xx 0 % (< 1%). See `evidence/test-reports/perf-load.md`. Measured on a 4-core i3 dev laptop + Docker PostgreSQL — not production hardware. |

---

## 6. Coverage snapshot (measured, not gated)

- **Backend:** 96.34 % lines · 87.57 % branches · 92.63 % functions. Low lines are non-reachable
  by design (`requestLogger.js` gated behind `REQ_LOG=1`, debug logger branches, CLI guards).
- **Frontend:** 87.76 % lines · 76.82 % branches · 75.40 % functions. Honest gaps: `LoginPage.jsx`
  5.63 %, `UsersPage.jsx` 6.01 % — both covered by the real browser journeys instead of units.
- Coverage is deliberately **never gated** by an arbitrary threshold (Phase 12 policy).

## 7. Known traceability gaps (disclosed, not hidden)

1. **Pilot usability timing (SC-06)** — not performed (no pilot cohort).
2. **Edge browser (NFR-09)** — Playwright ran Chromium only; Edge was not separately executed.
3. **UI step-counting (NFR-08)** — flows are proven working by E2E but were not formally counted.
4. **E2E against the Docker stack** — Playwright runs against host-started API/SPA on the
   disposable `b2b_oms_e2e` DB, not inside the containers; the deployed containers are covered
   by the HTTP-level `docker:smoke` (9/9) instead.

> Closed since Phase 15: **NFR-05 / SC-07 performance under load** was previously not measured and
> is now covered by the 20-vU benchmark (§5, `evidence/test-reports/perf-load.md`).

See [`limitations.md`](limitations.md) for the full, authoritative list.
