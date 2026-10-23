# Phase 9 — Audit Logging & Dashboard: test evidence

Date: 2026-10-22. Environment: Windows, Node 24, PostgreSQL 16.15 (Docker, host port
**5433**), backend CommonJS/Express, frontend React 18 + Vite. `NODE_ENV=test` for the
unit/integration suites and `development` for the live smoke and screenshots. This phase
shipped the append-only audit trail, the ADMIN-only audit/report surface, audited
administrative user management and the role-scoped dashboard
(`docs/api-specification.md` §2.6–§2.7, `docs/database-design.md` §2.9, decision **D-26**).

All commands below were EXECUTED this session; the raw console output is captured beside
this file as `phase9-*.txt`.

## 1. Quality gates

| Gate | Command | Result | Raw |
|---|---|---|---|
| Backend lint | `npm --prefix backend run lint` | **PASS** — 0 errors | `phase9-backend-lint.txt` |
| Format | `npm run format:check` | **PASS** — "All matched files use Prettier code style!" | `phase9-format-check.txt` |
| Backend unit | `npm --prefix backend test` | **PASS** — 95 tests / 95 pass / 0 fail | `phase9-backend-unit.txt` |
| Backend integration | `npm --prefix backend run test:integration` | **PASS** — 112 tests / 112 pass / 0 fail (isolated `b2b_oms_test` DB) | `phase9-integration-raw.txt` |
| Frontend lint | `npm --prefix frontend run lint` | **PASS** — 0 errors | `phase9-frontend-lint.txt` |
| Frontend unit | `npm --prefix frontend test` | **PASS** — 63 tests / 63 pass (7 test files) | `phase9-frontend-test.txt` |
| Frontend build | `npm --prefix frontend run build` | **PASS** — 75 modules transformed, built OK | `phase9-frontend-build.txt` |
| Live smoke | `node backend/scripts/smoke/phase9-dashboard-smoke.js` | **PASS** — 72 / 72 checks | `phase9-dashboard-smoke.txt` + `.json` |

## 2. Integration coverage added in Phase 9 (against the isolated test DB)

New HTTP suites (all green in `phase9-integration-raw.txt`):

- **Audit trail over HTTP**
  - *business changes are audited transactionally across the full lifecycle* — a single
    order lifecycle produces `ORDER_CREATED` + `STOCK_RESERVED` → `ORDER_STATUS_CHANGED`
    (+ `STOCK_CONSUMED` at ship) rows, each committed with its data change.
  - *failed and successful logins are recorded with the correct outcome* — `LOGIN_FAILED`
    is stored as `outcome=failure`; `LOGIN_SUCCESS` as `outcome=success`.
  - *filters: outcome, action, entity_type and date range; pagination meta* — the ADMIN
    read endpoint honours every filter and returns `{ page, limit, total }`.
- **Reports & dashboard over HTTP**
  - *the agent order-summary never carries the audit feed* — `/api/reports/order-summary`
    returns the same order metrics as the dashboard but with **no** `audit` key; the full
    `/api/reports/dashboard` (which embeds the feed) is ADMIN-only.
  - *aggregation accuracy on an isolated window (order value excludes cancelled, is not
    revenue)* — `booked_order_value` sums non-cancelled `grand_total`s only.
  - *low-stock report is paginated and every row is genuinely low*; *bad window params fail
    closed (400)*.
- **Administrative user management over HTTP**
  - *the directory is ADMIN-only*; *an admin role change is applied and audited
    transactionally*; *self-lockout: an admin cannot demote or deactivate their own
    account*; *deactivating an account blocks its next login (audited as a failure)*;
    *strict PATCH: unknown fields and no-op bodies are rejected; unknown id 404s*.
- Pre-existing suites were re-asserted for the Phase 9 guarantees:
  - Orders: *transaction consistency: rollback leaves neither order nor audit row*;
    *POST /api/orders … audits*.
  - Catalog & inventory: *PATCH /api/inventory/:id adjusts stock, writes a movement + audit row*.
  - Cart: *cart mutations are audited with the actor role*.
- **Database invariants**
  - *audit_logs is append-only at the DB level (UPDATE/DELETE blocked)* — the migration-11
    trigger refuses mutation.
  - *audit_logs.outcome stores success/failure and rejects anything else (migration 18)* —
    the new CHECK constraint.
  - **Migration reversibility (down --all, then up again)** — migration 18 reverses cleanly.

## 3. Frontend coverage (Vitest + React Testing Library)

`frontend/src/test/dashboard.test.jsx` (7 tests, green in `phase9-frontend-test.txt`):

- the ADMIN dashboard renders the summary cards, the activity feed and the "audit events
  recorded" count, and discloses that booked order value is **not collected revenue**;
- the ORDER_MANAGER dashboard renders the same cards but **no** "Recent activity" feed, **no**
  audit count and **no** audit link — and fetches only `/api/reports/order-summary` (it never
  calls `/api/reports/dashboard`);
- a low-stock alert shows the count and links to `/inventory`;
- the audit viewer shows a `LOGIN_FAILED` row as "Login failed" with a **Failure** badge and
  offers **no** edit/delete control;
- selecting the Outcome=failure filter sends `outcome=failure` to the API;
- a customer navigating to `/dashboard` is shown "Not authorized";
- an unauthenticated visit to `/audit` redirects to the login screen.

## 4. Live smoke — genuine activity minted and proven

`backend/scripts/smoke/phase9-dashboard-smoke.js` drives the **running** API (`:4000`) and
cross-checks PostgreSQL directly. It minted a real, self-contained set of activity and
**72 / 72** checks passed (`phase9-dashboard-smoke.json`, ids for this run: product `14`,
shipped order `8`, cancelled order `9`, invoice `6`, throwaway user `10`):

**Coverage / completeness** — the DB "event matrix" confirmed that this single run emitted,
each exactly once and all as `outcome=success`: `PRODUCT_CREATED`, `STOCK_ADJUSTED`,
`PRODUCT_DEACTIVATED`, `PRODUCT_ACTIVATED`, `ORDER_CREATED`, `STOCK_RESERVED`,
`ORDER_STATUS_CHANGED`, `STOCK_CONSUMED`, `INVOICE_ISSUED`, `INVOICE_VOIDED`,
`ORDER_CANCELLED`, `STOCK_RELEASED`; plus `USER_ROLE_CHANGED` + `USER_STATUS_CHANGED` for
the admin-managed throwaway account.

**Outcome semantics** — the bad-password attempt (`LOGIN_FAILED`) and the deactivated-account
attempt (`ACCOUNT_DISABLED_ATTEMPT`) are stored as `outcome=failure`.

**Access control** — `GET /api/audit-logs` and `GET /api/reports/dashboard` are **ADMIN-only**
(anon 401, customer 403, agent 403); `GET /api/reports/order-summary` and
`GET /api/reports/low-stock` are the **ADMIN + ORDER_MANAGER** staff view.

**Read-only trail** — `POST/PATCH/PUT/DELETE /api/audit-logs` all 404 (no write verb is
mounted), and the database itself **refuses `UPDATE` and `DELETE`** on `audit_logs`; the
`outcome` CHECK refuses any value outside `success`/`failure`.

**Privacy** — no `audit_logs.details` JSON contains a secret-bearing key
(`password` / `password_hash` / `authorization` / `access_token` / `refresh_token` / `jwt` /
`token`).

**Filters & validation fail closed** — `outcome=failure` returns only failure rows and
includes `LOGIN_FAILED`; `action=ORDER_CREATED` returns only that action; `limit` is
honoured with a larger `meta.total`; `limit=500` (> the 100 clamp) → **400**; an unknown
query param `role=admin` → **400** (strict schema).

**Metric honesty** — the admin dashboard embeds `audit.recent_activity`; the agent
order-summary carries the same `totals` but **no** `audit` key and `audience="order_manager"`;
`booked_order_value` is defined and its `metric_definitions` text explicitly says it is
**not collected revenue**; no totals key claims a collected/revenue figure.

After the run `audit_logs` held **93 rows** of genuine activity — deliberately left in the
dev database so the dashboard and audit screenshots show real data.

## 5. Reproducing the screenshots

Per the README "Evidence & screenshot instructions (Phase 9)" the captures
`evidence/screenshots/20-…`–`24-…` are taken against the live stack (DB `:5433`, backend
`:4000`, Vite dev server). They require the automated Browser view to be visible at a
positive viewport; when the Qoder Browser window is minimized the capture step is blocked
even though the app renders correctly. Open/focus the Browser window (~1440×900) and re-run
the capture to produce: `20-dashboard-admin.png`, `21-dashboard-metric-definitions.png`,
`22-audit-trail-admin.png`, `23-users-admin.png`, `24-dashboard-agent-no-feed.png`.

## 6. Notes / limitations

- "Order value" reported by the dashboard is **booked demand** (SUM of non-cancelled
  `grand_total`), never collected revenue — the platform performs no payment processing, so
  no revenue/sales/performance figure is produced anywhere.
- Low-stock and dashboard figures are instantaneous snapshots; the order window is based on
  `orders.created_at` and defaults to the trailing 30 days.
- Route-level role guards are UX only; the server is the authoritative access boundary, and
  the audit trail has no mutation path at any layer (API or DB).
