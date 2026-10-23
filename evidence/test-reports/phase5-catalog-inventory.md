# Phase 5 — Products & Inventory: test evidence

Date: 2026-10-22. Environment: Windows, Node 24, PostgreSQL 16.15 (Docker, host port
5433), backend CommonJS, `NODE_ENV=test` for suites / `development` for the live smoke
and screenshots. This phase shipped the catalog + inventory modules end to end
(`docs/api-specification.md` §2.2, decisions **D-20 / D-21 / D-22**).

## Checks EXECUTED and PASSED (real output, this session)

### 1. Backend unit suite — `npm --prefix backend test` → **51 pass / 0 fail**

Raw: `phase5-backend-unit.txt` (foundation + auth + new catalog unit tests). New
catalog unit coverage (`backend/tests/catalog-unit.test.js`):

| Area | Verified behaviours |
|---|---|
| `createProductSchema` | safe defaults applied + money normalized to 2-dec string; JSON-number price accepted + strings trimmed; **blank name / blank sku / zero-or-negative price / >2-decimal price rejected**; `tax_rate` outside 0..100 rejected; negative `initial_stock` / `low_stock_threshold` rejected; **strict** → unknown fields (`role`, `is_admin`) rejected |
| `updateProductSchema` | a single-field patch valid; empty patch rejected ("At least one field is required"); strict on unknown fields |
| `updateInventorySchema` | signed `delta` + `reason` valid; **zero delta rejected**; **non-integer delta rejected**; missing/blank `reason` rejected; strict |
| `productListQuerySchema` | defaults; boolish query coercion; **invalid sort column, bad order and out-of-range pagination fail closed (400)**; sort keys stay aligned with the repository whitelist |
| `inventoryListQuerySchema` / `productIdParamSchema` | staff view defaults (active+inactive, all stock); id parses a positive integer and rejects non-numeric / zero / negative |

### 2. Database + catalog integration — `npm run test:integration` → **51 pass / 0 fail / 0 cancelled**

Raw: `phase5-integration-raw.txt` — 20 Phase-3 schema tests + 16 Phase-4 auth tests +
**15 new catalog/inventory HTTP tests** (`backend/tests/catalog-http.test.js`), against
the isolated `b2b_oms_test` database only (opt-in gate `B2B_RUN_DB_TESTS=1`; plain
`npm test` skips it; `--test-concurrency=1` keeps the shared-DB files serial). New
coverage:

- `GET /api/products` is **public** and returns active products + `{data, meta}`; supports
  `search`, `sort=price`, and pagination; **rejects invalid query params with 400**
- `GET /api/products/:id` hides an inactive product from the public (404) but **not from
  an ADMIN** bearer token (`optionalAuthenticate` visibility)
- `POST /api/products`: ADMIN **201** + unique-SKU enforced (409 on collision) + the 1:1
  **inventory row is created atomically**; invalid body **400 without creating a row**;
  **anonymous 401, customer/agent 403** (customers cannot modify products)
- `PATCH /api/products/:id`: ADMIN edits + **deactivates (soft archive)**; other roles
  forbidden; unknown id 404; empty body 400; **SKU collision → 409**
- `GET /api/inventory` is **staff-only** (admin/agent 200, customer 403, anon 401);
  `GET /api/inventory/low-stock` returns **only rows with `available <= threshold`**
- `PATCH /api/inventory/:id`: an adjustment **writes one `inventory_movements` row + one
  `STOCK_ADJUSTED` audit row**; an adjustment that would go negative is refused and the
  **transaction rolls back** (no ledger/audit written); role + input + existence checks
- product responses **never leak internal columns** (no `password`/raw driver fields)

### 3. Frontend suite — `npm --prefix frontend test` → **21 pass / 0 fail**

Raw: `phase5-frontend-test.txt` — 3 files:
- `App.test.jsx` (2) — the Phase-2 landing-page health states still pass
- `catalog.test.jsx` (16) — every screen is driven by a **fetch stub keyed by
  `METHOD /path`** (so a page calling a wrong/parameterized endpoint fails): listing
  renders API rows, search/sort/pagination, empty + error states, product detail 200 /
  404, `RequireRole` redirect + customer block on admin screens, admin table with a
  real bearer `PATCH`, add-product form surfacing backend validation details, agent
  view-only inventory, admin adjust `PATCH /api/inventory/:id`, the `INSUFFICIENT_STOCK`
  409 shown in the form, and the low-stock toggle
- `pagination.test.js` (3) — **NaN regression guard**: `meta` carries only
  `{page, limit, total}` and the page count is derived client-side (D-21)

### 4. Live smoke vs the dev server → **66/66 checks passed**

Raw: `phase5-catalog-smoke.txt` + `phase5-catalog-smoke.json` (script kept as
`phase5-catalog-smoke.script.txt`), executed against a freshly migrated dev DB. Proved:
anonymous list is active-only + exposes `available_stock` and no credential columns;
server-side search/sort/pagination; **400 fail-closed** on `limit=999`,
`sort=drop_table`, unknown `role` param, and a malformed id; inactive detail → **404**;
ADMIN `active_only=false` sees the archived `LEGACY-01`; anon/customer/agent **cannot**
create (401/403/403); blank-name/negative-price → 400; ADMIN create → **201**; duplicate
SKU → **409 DUPLICATE_SKU**; the new product appears in low-stock at threshold 5; PATCH
price persists; customer PATCH → 403; empty PATCH → 400; unknown PATCH id → 404;
deactivation is a **soft delete** and the archived product is **404** to the public;
inventory role gates (customer/anon 403/401, order-manager 200); low-stock feed rows all
satisfy `available <= threshold`; order-manager/customer cannot adjust (403); zero-delta /
missing-reason / fractional-quantity → 400; **+60 receipt → `stock_receipt`**, then a
**−15 → `manual_adjustment`**; an over-drawdown → **409 INSUFFICIENT_STOCK and stock is
unchanged afterwards**; **DB assertions**: each successful adjustment wrote exactly one
ledger row (2 rows: +60, −15), create/update/deactivate/adjust are all audited with the
actor role, the refused oversell wrote **no audit row**, the audit detail carries `delta`
+ `available_after` (no secrets), and the product row **still exists (never
hard-deleted)**. The one leftover active SMOKE product was soft-deactivated through the
real `PATCH` endpoint afterwards (no hard delete).

### 5. Quality gates

- `npm run lint` / `npm --prefix backend lint` / `npm --prefix frontend lint`: **0 errors**
- `npm run format:check`: **all files formatted**
- `npm run build:frontend`: **PASS** — production bundle emitted
- Dev database migrated: migration 14 applied; `npm run db:health` → `schemaComplete: true`,
  13/13 tables

## Fixes made during this phase (found by real runs)

1. **`DataBoundary` eager-JSX crash** — pages passed eager JSX children so `data.data.map`
   ran while `data` was null. Converted all list/detail/inventory pages to the render-prop
   form `{(result) => …}` and made `DataBoundary` throw if children is not a function.
2. **`meta.totalPages` → "Page 1 of NaN"** (caught in browser screenshots) — the documented
   `meta` is only `{page, limit, total}`. Added `frontend/src/utils/pagination.js` to derive
   the page count client-side (D-21) + a NaN regression test; test stubs deliberately omit
   `totalPages` to mirror the real contract.
3. **Forms hid 409/403 messages** — they only rendered field-level `ValidationErrors`. Added
   `FormProblem` (message + details) to `States.jsx` and adopted it in the product form,
   inventory-adjust form, and login.
4. **`RequireRole` unmounted the guarded subtree** while the session was still bootstrapping
   (test body became `<div/>`) — fixed the harness `LoginLoader` to render children only once
   authenticated.
5. **Smoke read `created.data.id`** — create/detail/update return the bare object (only list
   returns `{data, meta}`); corrected to `created.id`.
6. **Smoke audit query** assumed `STOCK_ADJUSTED` used `entity_type='product'`; the service
   writes `'inventory'` — broadened the query and added an assertion that STOCK_ADJUSTED rows
   use `entity_type='inventory'`.
7. **First-Search-click empty flicker** in the browser — added a monotonic `requestId` guard in
   `useApi` so only the newest response writes state.

## NOT executed / remain unverified (honest list)

- **FR-CAT-08 "inactive products cannot be ordered"** is enforced at catalog level in this
  phase (active-only listing + `404` on inactive detail). The cart/order **rejection** path
  lands with the cart module (Phase 6) — there is no cart yet to place an order against.
- **Full `docker compose up --build`** with the Phase 5 code not executed in this session
  (compose unchanged; new files ship via existing COPY rules).
- No **load/soak** or true **concurrent-adjustment** benchmark — the `SELECT … FOR UPDATE`
  serialization + DB CHECK guard is proven functionally (refused oversell → 409, no writes)
  but not under parallel load.
- Screenshots were captured against the live dev app with seeded data; a scripted Playwright
  run is deferred to the E2E phase (the reproduction commands are in the README "Evidence &
  screenshot instructions" section).
