# Phase 6 — Customer Shopping Cart: test evidence

Date: 2026-10-22. Environment: Windows, Node 24, PostgreSQL 16.15 (Docker, host port
5433), backend CommonJS, `NODE_ENV=test` for the suites. This phase shipped the shopping
cart module end to end (`docs/api-specification.md` §2.3, decision **D-23**), backed by the
existing `carts` / `cart_items` tables plus one new migration (15) that adds a documented
per-line maximum.

The cart is **self-scoped, server-priced, and never a stock reservation**: ownership comes
only from the access token, prices/totals are recomputed from the live catalog on every
read, and add/update only *reads* available stock to reject an obviously-unfulfillable
quantity — inventory is re-verified authoritatively at order placement (Phase 7).

## Checks EXECUTED and PASSED (real output, this session)

### 1. Backend unit suite — `npm --prefix backend test` → **69 pass / 0 fail**

Raw: `phase6-backend-unit.txt` (foundation + auth + catalog + new cart unit tests). New
cart coverage (`backend/tests/cart-unit.test.js`, 18 tests):

| Area | Verified behaviours |
|---|---|
| `utils/money.js` (D-09 / AC-CART-02) | `toCents`/`fromCents` round-trip; `roundHalfUp` uses BigInt and rounds .5 up; `computeLine` reproduces the fixture `19.99 × 3 @ 7.50% → line_total 59.97 / line_tax 4.50`; multi-line `summarize` holds the invariant `grand_total = subtotal + tax_total` to the cent |
| `cartQuantity` validator | accepts `1..1000`; rejects `0`, negative, fractional, and `1001` (the documented per-line max, `constants/cart.js`); non-numeric rejected |
| `addCartItemSchema` | `product_id` must be a positive integer id; `quantity` defaults to 1; **strict** → any `customer_id`/`cart_id`/`unit_price`/`total` field is rejected outright |
| `updateCartItemSchema` | requires an absolute `quantity ≥ 1`; strict on unknown fields |
| `cartItemIdParamSchema` | parses a positive-integer `:itemId`; rejects non-numeric / zero / negative |

### 2. Database + cart integration — `npm run test:integration` → **67 pass / 0 fail / 0 cancelled**

Raw: `phase6-integration-raw.txt` — the 20 Phase-3 schema tests + 16 Phase-4 auth tests +
15 Phase-5 catalog/inventory tests + **16 new cart HTTP tests**
(`backend/tests/cart-http.test.js`, focused raw: `phase6-cart-http.txt`), run against the
isolated `b2b_oms_test` database only (opt-in gate `B2B_RUN_DB_TESTS=1`; plain `npm test`
skips it; `--test-concurrency=1` keeps the shared-DB files serial). Migration 15 is applied
by the runner and exercised by the **migration-reversibility** suite (`down --all`, then `up`
restores the identical schema), proving the new `CHECK` constraint is reversible. New
coverage:

- **Customer-only** — anonymous `401`, admin/agent `403` on every cart route
- `GET /api/cart` starts empty with exact `"0.00"` totals and no client-settable owner field
- `POST /api/cart/items` computes totals **server-side** (59.97 / 4.50 / 64.47) and returns
  the full cart; a client-sent `unit_price`/`total` in the body is rejected `400` (strict)
- **Upsert merge** — re-adding a product increases the existing line's quantity and leaves a
  **single DB row** (FR-CART-01 / AC-CART-01)
- **Quantity validation** — `0` / negative / fractional / `> 1000` → `400`; invalid/missing
  `product_id` → `400` (AC-CART-04)
- **Inactive product** cannot be added → `404 PRODUCT_NOT_FOUND`, no line created
  (FR-CART-02, completes FR-CAT-08)
- **No reservation** — adding more than available stock is refused `409 INSUFFICIENT_STOCK`
  and reserves nothing; when an admin later reduces on-hand below a stored line, the next
  `GET` raises `stock_warning` with the cart unchanged (AC-CART-03)
- `PATCH /api/cart/items/:itemId` updates an absolute quantity; unknown id → `404`;
  `DELETE /api/cart/items/:itemId` then `DELETE /api/cart` → `204` empties it (FR-CART-05)
- **Cross-customer isolation** — one customer can neither see nor mutate another's cart
  (a foreign item id → `404`) (AC-CART-05)
- **Persistence across sessions** — a freshly re-signed token for the same user reloads the
  identical cart
- Totals **recompute from the current catalog price** at read time (no stale price stored)
- Every mutation writes an audit row with the actor role
  (`CART_ITEM_ADDED` / `CART_ITEM_UPDATED` / `CART_ITEM_REMOVED` / `CART_EMPTIED`)

### 3. Frontend suite — `npm --prefix frontend test` → **32 pass / 0 fail**

Raw: `phase6-frontend-test.txt` — now 4 files: the 3 Phase-5 files plus
`src/test/cart.test.jsx` (**11 tests**). Every screen is driven by a fetch stub keyed by
`METHOD /path`, so a component calling a wrong/parameterized cart endpoint fails. New
coverage: `AddToCart` posts only `{product_id, quantity}` (never a price) and surfaces
backend errors; the cart page renders server-derived line totals and the subtotal/tax/grand
rows; quantity −/+ controls issue an absolute `PATCH`; remove hits `DELETE /api/cart/items/:id`;
"Empty cart" hits `DELETE /api/cart`; the empty-cart state renders; the `stock_warning` and
`unavailable` flags render; an API `409 INSUFFICIENT_STOCK` is shown as a readable message;
the `/cart` route is guarded to customers (admin/agent redirected); and the "adding to cart
does not reserve stock" notice is present.

### 4. Quality gates

- `npm run lint` (backend + frontend): **0 errors** — raw `phase6-backend-lint.txt`, `phase6-frontend-lint.txt`
- `npm run build:frontend`: **PASS** — production bundle emitted (`phase6-frontend-build.txt`)
- `npm run format:check`: **all matched files use Prettier style** (`phase6-format-check.txt`)

## Requirement → evidence mapping (traceability closed for this phase)

| Requirement | Status | Proof |
|---|---|---|
| FR-CART-01 (one cart, upsert merge) | as-built | cart-http "merges quantity, single DB row" |
| FR-CART-02 (reject inactive / qty < 1) | as-built | cart-http 404 + 400; cart-unit validators |
| FR-CART-03 (server-side totals) | as-built | cart-http server-side totals; cart-unit money fixture |
| FR-CART-04 (warn, never reserve) | as-built | cart-http "refuses over-stock, reserves nothing" + stock_warning |
| FR-CART-05 (empty cart; auto-clear on order) | **partial** | manual `DELETE /api/cart` shipped; auto-clear on order lands with Phase 7 orders |
| FR-CAT-08 (inactive products not orderable) | as-built | cart add of an inactive product → 404 |
| NFR-07 (exact money) | as-built | money unit tests + `grand = subtotal + tax` invariant |
| AC-CART-05 (ownership) | as-built | cart-http cross-customer isolation + persistence across sessions |

## Fixes made during this phase (found by real runs)

1. **Invalid `in` assertion** in `cart-http.test.js` (`'price_from_client' in
   JSON.stringify(...)` is illegal on a string) — replaced with `.includes()`; that was the
   only initial failure, after which all 16 cart HTTP tests pass.
2. **Frontend duplicate-text query** — `'₹ 59.97'` matched both a line total and the
   subtotal; scoped the line assertion to `.cart-item__total strong` and read the subtotal
   inside the summary block with `within(...)`.
3. **Test harness route ambiguity** — the literal `/products/1` child route was more
   specific than `/products/:id`; switched the catch to `path="*"`.
4. **PowerShell env leak** — exporting `B2B_RUN_DB_TESTS`/`NODE_ENV` in a reused shell made a
   later plain `npm test` run (not skip) the DB suites and race; resolved by clearing those
   vars inline in each non-integration command. The integration runner sets its own env in a
   spawned process, so it is unaffected.
5. Removed an unused `waitFor` import (frontend lint) and a leftover draft `readCart` helper
   in `cart.service.js`; ran Prettier on the 5 files flagged by `format:check`.

## NOT executed / remain unverified (honest list)

- **FR-CART-05 second clause** — "upon successful order creation the cart shall be emptied
  automatically" — is **not** exercised here because order creation is Phase 7. The manual
  `DELETE /api/cart` path is fully covered; the automatic clear-on-order test ships with
  `orders.test.js`.
- **No dedicated live HTTP smoke script** for the cart (Phase 5 had
  `phase5-catalog-smoke.js`). The 16 Supertest integration tests run against the real
  migrated test DB, which covers the same ground; a scripted browser walkthrough +
  screenshots are deferred to the E2E phase.
- **Full `docker compose up --build`** with the Phase 6 code was not executed this session
  (compose is unchanged; the new backend/frontend files ship via the existing COPY rules and
  were validated by unit + integration + build).
- **No concurrent/load test on the cart** — the "no reservation" contract means the cart does
  no locking; correctness under parallel checkout is a Phase 7 (order) concern and will be
  gated there.
