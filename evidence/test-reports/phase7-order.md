# Phase 7 — Order Management & Inventory Transactions

**Scope:** real, concurrency-safe order placement against live inventory, the enforced
lifecycle state machine, per-user idempotency, reserve/consume/release stock accounting, and
the React order workflow — all end to end on Express + PostgreSQL.

Status: **complete**. Invoicing (FR-INV) is deliberately deferred to Phase 8 (see decision D-24).

---

## 1. What shipped

### Backend (Express, layered, strict-Zod, parameterized SQL)

| Surface | Behaviour |
|---|---|
| `POST /api/orders` (**customer**) | Idempotent, atomic order creation. Reads the cart server-side (or explicit `items[]`), re-prices every line server-side (integer-cent), snapshots historical name/price, re-checks availability under row locks, **reserves** stock (`reserved += qty`), empties the cart and writes an audit row — all in ONE transaction. Any shortfall/inactive/unknown product aborts the whole order and leaves stock untouched. |
| `GET /api/orders` | Customer sees only their own; ADMIN/ORDER_MANAGER see all. `status` filter + (staff) `customer` filter + paging. |
| `GET /api/orders/:id` + `/items` | Ownership enforced from `req.user.id`; foreign reads → `404` (no existence leak). |
| `PATCH /api/orders/:id/status` (**ADMIN/ORDER_MANAGER**) | One-step forward move only; illegal skip/backward/terminal → `409 INVALID_STATE_TRANSITION`. Reaching `shipped` **consumes** stock once (`physical -= qty AND reserved -= qty`). |
| `POST /api/orders/:id/cancel` (**distinct op**) | Legal only from `pending`/`confirmed`; **releases the reservation exactly once** (`reserved -= qty`). Post-shipment / re-cancel → `409`. |

- `constants/orders.js` — single source of truth for the lifecycle chain
  `pending → confirmed → processing → shipped → delivered` (+ `pending|confirmed → cancelled`),
  the forward-edge matrix, `CONSUMPTION_STATUS = shipped`, `CANCELLABLE_STATUSES`, and movement
  kinds `order_reservation` / `cancellation_release` / `fulfillment_consumption`.
- `repositories/order.repository.js` — `SELECT … FOR UPDATE` inventory locks taken **one product
  at a time in ascending product-id order** (deadlock-free serialisation) with reservation/available
  `CHECK`s as the final oversell guard; reserve/consume/release primitives each paired with a ledger
  movement; order + order-item CRUD; idempotency claim/lookup primitives.
- `services/order.service.js` — idempotency layer (claim committed **before** any stock work;
  completed key replays stored body `200 idempotent:true`; concurrent in-progress → `409
  DUPLICATE_REQUEST`; reused key with different body → `409 IDEMPOTENCY_CONFLICT`; failed claim
  freed for retry) wrapping the atomic `withTransaction` create and the transition/cancel machine.
- `migrations/1735689600016_order-lifecycle-and-idempotency-hash.js` — widens the `orders.status`
  CHECK to the six-value domain, **retiring `fulfilled`**, and adds `idempotency_keys.request_hash`
  (SHA-256 of the normalised line set). Fully reversible.

### Frontend (React 18 + Vite + react-router v7)

- `/cart` — **Place order** posts `POST /api/orders` with one fresh `Idempotency-Key` per attempt
  (`utils/uuid.js`) and navigates to the confirmation screen.
- `/orders` — order history (`OrderHistoryPage`).
- `/orders/:id` — order detail with a lifecycle timeline + a cancel form (`OrderDetailPage`).
- `/orders/:id/confirmation` — post-order confirmation (`OrderConfirmationPage`).
- `/orders/manage` — staff order-processing console advancing one legal step at a time
  (`OrderProcessingPage`), role-guarded via `RequireRole`.
- Supporting: `services/api.js` order functions, `constants/orderStatus.js`,
  `components/OrderStatusBadge.jsx`, order styles in `styles-catalog.css`.

---

## 2. Test results (all green — final run, after formatting)

| Command | Result | Raw evidence |
|---|---|---|
| backend lint (`eslint .`) | **PASS** — 0 problems | `phase7-backend-lint.txt` |
| frontend lint (`eslint .`) | **PASS** — 0 problems | `phase7-frontend-lint.txt` |
| `npm --prefix backend test` (DB suites auto-skip) | **PASS** — **79/79**, 0 fail | `phase7-backend-unit.txt` |
| `npm run test:integration` (isolated `b2b_oms_test`) | **PASS** — **85/85**, 0 cancelled / 0 fail | `phase7-integration-raw.txt` |
| `npm --prefix frontend test` | **PASS** — **46/46** (5 files) | `phase7-frontend-test.txt` |
| `npm run build:frontend` | **PASS** — bundle emitted | `phase7-frontend-build.txt` |
| `npm run format:check` | **PASS** — all files match Prettier style | `phase7-format-check.txt` |

New Phase 7 coverage:
- **10 order unit tests** (`order-unit.test.js`) — lifecycle matrix (edges, no skip/backward,
  terminals), money fixtures, strict Zod order schemas (price-agnostic, unknown-field rejection).
- **18 order HTTP tests** (`order-http.test.js`) — listed below.
- **14 frontend order tests** (`orders.test.jsx`) — history, detail + cancel, confirmation,
  staff processing, checkout posting one idempotency key, route/role guards.

### Key guarantees exercised against the real database

- **Overselling prevented under concurrency** — 20 concurrent buyers for 5 units: exactly 5 win
  (201), 15 get `409 INSUFFICIENT_STOCK`, `available` never negative.
- **Whole-order rollback** — a shortfall mid-create leaves orders/items/inventory/cart unchanged.
- **Idempotent replay** — same key → `200 idempotent:true`, a single order row, `reserved` booked
  exactly once; a reused key with a different body → `409 IDEMPOTENCY_CONFLICT`; staggered
  double-submit yields one order.
- **Reserve / consume / release accounting** — reserved stock consumed exactly once at `shipped`;
  released exactly once on pre-shipment cancel; a unit can never be deducted twice.
- **Lifecycle enforcement** — legal chain runs `pending → … → delivered`; skips/backward/terminal
  moves → `409 INVALID_STATE_TRANSITION`; customer `PATCH status` → `403`.
- **Snapshot immutability** — order-item price/name unaffected by later catalog edits.
- **Cross-customer isolation** — foreign read/items/cancel → `404`.
- **Migration-16 reversibility** — `down --all` then `up` round-trips cleanly (the reversibility
  test truncates `orders` first so committed lifecycle rows can't skew the DDL CHECK re-add).

---

## 3. How to reproduce

```powershell
# Backend lint + unit (no DB)
cd backend; node node_modules/eslint/bin/eslint.js .
$env:B2B_RUN_DB_TESTS=''; $env:NODE_ENV='test'; node --test --test-reporter=spec

# Integration (needs the docker db running: docker compose up -d db)
cd backend; node scripts/db/run-integration-tests.js

# Frontend lint + test + build
cd frontend; node node_modules/eslint/bin/eslint.js .
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build

# Format (repo root)
node node_modules/prettier/bin/prettier.cjs --check "**/*.{js,jsx,json,md,css,html}"
```

> Run the DB-backed suites **sequentially** against the isolated `b2b_oms_test` database and keep
> `B2B_RUN_DB_TESTS` unset for the plain unit run — concurrent runs contend on the shared
> migration advisory lock and the `orders` table.
