# API Specification — B2B Order Management Platform

**Document version:** 1.6 (Phase 9 — §2.1 admin user management, §2.6 audit and the new §2.7 reports/dashboard are as-built; audit `outcome` + auth/user events per D-26; earlier: §2.5 invoices as-built per D-25)
**Base URL:** `/api` · All request/response bodies are `application/json; charset=utf-8` unless noted.
**Related:** `requirements.md` (FR IDs), `database-design.md`, `acceptance-criteria.md` (AC IDs)

---

## 1. Conventions

- **Auth:** `Authorization: Bearer <JWT>` (short-lived access token) on every protected endpoint; the rotating refresh token travels only in an `HttpOnly; SameSite=Strict; Path=/api/auth` cookie (D-19). Public endpoints: `POST /api/auth/register|login|refresh|logout`, `GET /api/health`, and the read-only catalog `GET /api/products` and `GET /api/products/:id` (anonymous sees active products only; an `optionalAuthenticate` ADMIN bearer additionally sees archived rows).
- **Roles:** `admin`, `agent`, `customer`. Column **Roles** below lists who passes `authorize(...)`; ownership rules (customer may only touch their own resources) are additionally enforced in services.
- **Pagination:** `?page=<1-based>&limit=...>`; responses include `"meta": {"page", "limit", "total"}` (the page count is derived client-side — D-21). `limit` max is `100`; the default is `25` for auth/user listings and `20` for the Phase 5 catalog/inventory endpoints.
- **Timestamps:** ISO-8601 UTC. **Money in JSON:** strings with 2 decimals (`"19.99"`) to avoid float ambiguity; server parses as decimal.
- **Idempotency:** `Idempotency-Key: <client UUID>` header required on `POST /api/orders` only (v1 scope, D-08).
- Unknown body fields are rejected (`z.strictObject` → `400 VALIDATION_ERROR`).

## 2. Endpoint reference

### 2.1 Auth & Users

> **As-built (Phase 4 auth / Phase 9 users).** The five auth endpoints below are
> live, and the ADMIN-only `/api/users*` directory/management endpoints (§bottom)
> shipped in Phase 9. There is deliberately **no `POST /api/users`** — account
> creation is the public CUSTOMER-only `POST /api/auth/register` flow; an admin
> may only change an existing user's `role`/`is_active` (never create, rename,
> re-email or reset a password through this surface).

#### `POST /api/auth/register` — public, rate-limited
```jsonc
// request (CUSTOMER accounts only; any `role`/unknown field → 400)
{ "email": "buyer@test.local", "password": "S3cure!pw12", "name": "Buyer Co" }
// 201 — Set-Cookie: refresh_token=<envelope>; HttpOnly; SameSite=Strict; Path=/api/auth
{ "message": "Account created",
  "user": { "id": "12", "email": "buyer@test.local", "name": "Buyer Co", "role": "customer", "createdAt": "…" },
  "accessToken": "<jwt>" }
// errors: 400 VALIDATION_ERROR · 409 EMAIL_TAKEN · 429 RATE_LIMITED
```
Password policy: ≥ 10 chars with at least one letter and one digit; stored only as a
bcrypt hash (cost `BCRYPT_ROUNDS`, default 12). A default cart is created atomically.

#### `POST /api/auth/login` — public, rate-limited
```jsonc
// request
{ "email": "buyer@test.local", "password": "S3cure!pw12" }
// 200 — same Set-Cookie as register; refresh token is NEVER in the body
{ "message": "Login successful", "user": { … }, "accessToken": "<jwt>" }
// errors: 400 VALIDATION_ERROR · 401 INVALID_CREDENTIALS (identical for unknown email
//         and wrong password) · 403 ACCOUNT_DISABLED · 429 RATE_LIMITED
```

#### `POST /api/auth/refresh` — cookie only, rate-limited
```jsonc
// request: none (reads the refresh_token cookie); rotates it
// 200 { "message": "Token refreshed", "user": { … }, "accessToken": "<jwt>" }
// errors: 401 INVALID_REFRESH_TOKEN · 401 TOKEN_REUSED (spent token presented —
//         the entire rotation family is revoked) · 429 RATE_LIMITED
```

#### `POST /api/auth/logout` — cookie only
```jsonc
// 200 { "message": "Logged out" }  (best-effort: revokes the family, clears the cookie)
```

#### `GET /api/auth/me` — any authenticated role
```jsonc
// 200 — identity comes strictly from the access token; hash-free profile
{ "user": { "id": "12", "email": "buyer@test.local", "name": "Buyer Co", "role": "customer", "isActive": true } }
// errors: 401 UNAUTHENTICATED (missing/malformed/expired/forged token or disabled account)
```

#### `GET /api/users` — admin (`?role=&page=&limit=`)
```jsonc
// 200 — SAFE columns only; password_hash is never selected on any user path (R-06)
{ "data": [ { "id": "…", "email": "…", "name": "…", "role": "customer",
              "is_active": true, "created_at": "…", "updated_at": "…" } ],
  "meta": { "page": 1, "limit": 25, "total": 203 } }
// errors: 401 · 403 FORBIDDEN_ROLE · 400 VALIDATION_ERROR (bad role/paging)
```

#### `GET /api/users/:id` — admin
```jsonc
// 200 → the same hash-free user object · errors: 401 · 403 · 404 USER_NOT_FOUND
```

#### `PATCH /api/users/:id` — admin (audited)
```jsonc
// request — ONLY role and/or is_active are accepted; any other field → 400
{ "role": "agent" }            // or { "is_active": false } · or both
// 200 → updated safe user object (no password fields ever)
// errors: 400 · 401 · 403 · 404 USER_NOT_FOUND
//         409 SELF_ROLE_CHANGE_NOT_ALLOWED · 409 SELF_DEACTIVATION_NOT_ALLOWED
```
*The role/status update and its `USER_ROLE_CHANGED` / `USER_STATUS_CHANGED` audit row commit in ONE transaction (NFR-13). A no-op body changes nothing and is intentionally NOT audited. **Self-lockout guard:** an admin cannot demote or deactivate their own account — another admin must. Effect (FR-AUTH-06): a deactivated user then gets `401`/`403` on all subsequent calls (auth middleware re-checks `is_active` every request), and the next login attempt is audited as `ACCOUNT_DISABLED_ATTEMPT` with outcome `failure`. (as-built, Phase 9, D-26).*

### 2.2 Products & Inventory

> **As-built (Phase 5).** All seven endpoints below are live and layered
> routes → controllers → services → repositories, with Zod `.strict()` on every
> body/query/path and parameterized SQL only. Role aliases are the API names
> (`ADMIN`, `ORDER_MANAGER` = DB `agent`). Products are **never physically
> deleted** — there is no DELETE route; deactivation is a soft archive via
> `is_active=false` (order history references stay intact through the RESTRICT FK).

**Product object** (returned by list rows, detail, create, and update — `id` is a
string, money columns are decimal strings):
```jsonc
{ "id": "10", "sku": "WG-100", "name": "Widget 100", "description": "Industrial widget",
  "unit_price": "19.99", "tax_rate": "7.5", "is_active": true,
  "physical_quantity": 100, "reserved_quantity": 0, "available_stock": 100,
  "low_stock_threshold": 20, "created_at": "…", "updated_at": "…" }
```

**Inventory row** (staff table — keyed by `product_id`):
```jsonc
{ "product_id": "10", "sku": "WG-100", "name": "Widget 100", "is_active": true,
  "physical_quantity": 100, "reserved_quantity": 0, "available_quantity": 100,
  "low_stock_threshold": 20, "is_low_stock": false }
```

#### `GET /api/products` — public (`optionalAuthenticate`)
Query (all optional; unknown param → `400` because the schema is `.strict()`):
`?search=<name|sku|description ILIKE>&sort=name|price|sku|created_at|available`
(default `name`) `&order=asc|desc` (default `asc`) `&active_only=<bool>`
(default `true`) `&page=<1-based>` `&limit=<1..100, default 20>`.
An ADMIN bearer token may pass `active_only=false` to also see archived rows; a
non-admin (or anonymous) caller is **forced** to active-only (fail-closed).
```jsonc
// 200
{ "data": [ /* Product objects */ ], "meta": { "page": 1, "limit": 20, "total": 55 } }
// errors: 400 VALIDATION_ERROR (limit=999, sort=drop_table, unknown `role` param)
```
*The page count is **not** in `meta` — clients derive `ceil(total/limit)` (see D-21).*

#### `GET /api/products/:id` — public (`optionalAuthenticate`)
```jsonc
// 200 → full Product object
// errors: 400 (id not a positive integer) · 404 NOT_FOUND
//         (unknown id, OR inactive id when the caller is not an ADMIN)
```

#### `POST /api/products` — `ADMIN` only
```jsonc
// request (unknown field → 400; only these are accepted)
{ "sku": "WG-100", "name": "Widget 100", "description": "Industrial widget",
  "unit_price": "19.99", "tax_rate": "7.5",
  "initial_stock": 100, "low_stock_threshold": 20, "is_active": true }
// 201 → Product object (inventory row created atomically with the product)
// errors: 400 VALIDATION_ERROR (blank name/price ≤ 0/sku blank or > 50,
//         initial_stock or threshold a negative/non-integer, tax ∉ [0,100])
//         · 401 UNAUTHENTICATED · 403 FORBIDDEN_ROLE · 409 DUPLICATE_SKU
```
*Creating a product writes the `products` row, its 1:1 `inventory` row, and a
`PRODUCT_CREATED` audit record in ONE transaction.*

#### `PATCH /api/products/:id` — `ADMIN` only
```jsonc
// request: any non-empty subset of
// { sku, name, description, unit_price, tax_rate, is_active, low_stock_threshold }
// 200 → updated Product object (re-read after commit)
// errors: 400 (empty body → "At least one field is required") · 401 · 403
//         · 404 NOT_FOUND · 409 DUPLICATE_SKU (sku changed onto an existing one)
```
**Deactivation / archival:** `{ "is_active": false }` is the supported way to retire
a product — it disappears from the public catalog (`404` on detail) but the row and
its `order_items` references are preserved. Audited as `PRODUCT_DEACTIVATED`, or
`PRODUCT_UPDATED` for any other change.

#### `GET /api/inventory` — `ADMIN`, `ORDER_MANAGER`
Query: `?search=<name|sku ILIKE>&active_only=<bool, default false>`
`&low_stock_only=<bool, default false>&page=&limit=<default 20>`.
```jsonc
// 200
{ "data": [ /* Inventory rows, low-stock first then name A-Z */ ],
  "meta": { "page": 1, "limit": 20, "total": 6 } }
// errors: 401 · 403 FORBIDDEN_ROLE (customer/anonymous) · 400 (strict/invalid query)
```
*Customers never see the physical/reserved breakdown — that is the point of this split.*

#### `GET /api/inventory/low-stock` — `ADMIN`, `ORDER_MANAGER`
Same as `GET /api/inventory` with `low_stock_only` forced `true`.
```jsonc
// 200 { "data": [ /* rows where available_quantity <= low_stock_threshold */ ], "meta": {…} }
```

#### `PATCH /api/inventory/:id` — `ADMIN` only (`:id` is the **product id**)
```jsonc
// request
{ "delta": 60, "reason": "Goods received", "low_stock_threshold": 20 /*optional*/ }
// 200
{ "data": { /* updated Inventory row */ },
  "movement": { "quantity_delta": 60, "movement_type": "stock_receipt",
                "available_after": 160, "reason": "Goods received" } }
// errors: 400 (delta = 0 / non-integer / missing reason) · 401 · 403 FORBIDDEN_ROLE
//         · 404 NOT_FOUND (no such product) · 409 INSUFFICIENT_STOCK (would make
//           physical OR available go negative)
```
**Transactional & audited by construction:** the row is locked `SELECT … FOR UPDATE`,
`physical_quantity` moves by `delta` (available recomputes via the generated column),
one append-only `inventory_movements` row is written
(`stock_receipt` when `delta>0`, `manual_adjustment` when `delta<0`), and a
`STOCK_ADJUSTED` audit row (carrying `delta`, `movement_type`, `available_after`,
`reason`) is created — **all in the same transaction**. The DB `CHECK`s are the final
oversell guard: a lost race still returns `409 INSUFFICIENT_STOCK` (the refused
adjustment writes neither movement nor audit).

**Low-stock definition (D-20):** `inventory.low_stock_threshold` is a per-product
non-negative integer (`NOT NULL DEFAULT 20`); a product is **low-stock** iff
`available_quantity <= low_stock_threshold`. It is settable at create, via product
PATCH, or via the inventory PATCH.

### 2.3 Cart

> **As-built (Phase 6).** All five cart endpoints below are live and layered
> routes → controllers → services → repositories, with strict Zod schemas and
> parameterized SQL. The cart is persisted in PostgreSQL (`carts` 1:1
> `customers` via a UNIQUE `customer_id`, lines in `cart_items`).

All cart endpoints: **customer only** (`authenticate` + `authorize('CUSTOMER')`),
operating on the caller's own cart. **The owner is derived exclusively from the
access token (`req.user.id`) — there is no cart or customer id in any URL or
body, so a customer can neither read nor mutate another customer's cart**
(AC-CART-05). A foreign item id simply is not in the caller's cart and returns
`404` (never `403`, so existence isn't leaked). Any client-supplied
`customer_id`/`cart_id`/`unit_price`/`subtotal` field is rejected outright
(`400 VALIDATION_ERROR`).

**Cart ≠ reservation of stock (FR-CART-04 / D-23):** adding or updating a line
only *reads* current `available_quantity` to reject an obviously-unfulfillable
quantity — it never locks or decrements inventory. Because stock can change after
a line is added, every `GET /api/cart` recomputes live prices and availability and
flags `stock_warning` (stored qty > on-hand) or `unavailable` (product deactivated
after being added). **Inventory is re-verified authoritatively under a
`SELECT … FOR UPDATE` lock only when the order is placed (Phase 7).**

**Documented maximum quantity per cart line: `1000` units** (`backend/src/constants/cart.js`),
enforced both by the Zod schema (`400 VALIDATION_ERROR`) and by a database `CHECK`
constraint (migration 15), so a merged/updated line above it returns
`409 CART_LINE_LIMIT_EXCEEDED`.

**Server-derived money:** `unit_price`, `line_total`, `line_tax`, `subtotal`,
`tax_total`, and `grand_total` are always computed from the *current* catalog using
integer-cent math with half-up per-line rounding (D-09), guaranteeing
`grand_total = subtotal + tax_total` to the cent. Prices sent by the browser are
never trusted or stored.

**Cart object** (returned by `GET /api/cart` and after every successful mutation):
```jsonc
{ "id": "7", "items": [
    { "id": "3", "product_id": "10", "product_name": "Widget 100", "sku": "WG-100",
      "unit_price": "19.99", "quantity": 3, "line_total": "59.97", "line_tax": "4.50",
      "available_now": 2, "is_active": true, "unavailable": false, "stock_warning": true }
  ],
  "subtotal": "59.97", "tax_total": "4.50", "grand_total": "64.47" }
```
*An empty cart returns `items: []` with all totals `"0.00"` (never `404`).*

#### `GET /api/cart` — customer
```jsonc
// 200 → full Cart object (live prices/availability, server-derived totals)
// errors: 401 UNAUTHENTICATED · 403 FORBIDDEN_ROLE (admin/agent)
```

#### `POST /api/cart/items` — customer
```jsonc
// request (strict; unknown field or any price → 400). `quantity` defaults to 1
{ "product_id": "10", "quantity": 3 }
// 201 → updated full Cart object
// Upsert merge (FR-CART-01): re-adding a product increases the existing line's
// quantity instead of creating a duplicate row.
// errors: 400 VALIDATION_ERROR (qty < 1 / non-integer / > 1000)
//         · 401 · 403
//         · 404 PRODUCT_NOT_FOUND (unknown OR inactive product — FR-CART-02/FR-CAT-08)
//         · 409 CART_LINE_LIMIT_EXCEEDED (merged qty > 1000)
//         · 409 INSUFFICIENT_STOCK (merged qty > available — courtesy check, reserves nothing)
```

#### `PATCH /api/cart/items/:itemId` — customer
```jsonc
// request { "quantity": 5 }        // set absolute; 1 ≤ qty ≤ 1000
// 200 → updated full Cart object
// errors: 400 VALIDATION_ERROR · 401 · 403
//         · 404 CART_ITEM_NOT_FOUND (unknown id OR an item belonging to another cart)
//         · 409 PRODUCT_UNAVAILABLE (product deactivated after being added)
//         · 409 INSUFFICIENT_STOCK (qty > available)
```

#### `DELETE /api/cart/items/:itemId` — customer
```jsonc
// 200 → updated full Cart object
// errors: 400 (bad itemId) · 401 · 403 · 404 CART_ITEM_NOT_FOUND (unknown/foreign)
```

#### `DELETE /api/cart` — customer
```jsonc
// 204 (no body) — empties the caller's cart (FR-CART-05)
// errors: 401 · 403
```
*Each mutation writes an audit row (`CART_ITEM_ADDED` / `CART_ITEM_UPDATED` /
`CART_ITEM_REMOVED` / `CART_EMPTIED`) in the SAME transaction as the change.*

### 2.4 Orders

> **As-built (Phase 7).** Orders are live and layered routes → controllers →
> services → repositories with strict Zod schemas, parameterized SQL, and one
> PostgreSQL transaction per write. Creation **reserves** stock; the lifecycle is
> `pending → confirmed → processing → shipped → delivered` (plus
> `pending|confirmed → cancelled`); reserved stock is **consumed exactly once at
> `shipped`** and **released exactly once on cancellation** (D-24). Reaching
> `shipped` also **mints the order's invoice atomically** in the same transaction
> (§2.5, D-25).

**Order object** (returned by create / detail / status / cancel):
```jsonc
{ "id": "…", "status": "pending", "customer_id": "…",
  "items": [ { "id": "…", "product_id": "…", "product_name": "Widget 100",
               "unit_price": "19.99", "tax_rate": "7.50", "quantity": 3,
               "line_total": "59.97", "line_tax": "4.50" } ],
  "subtotal": "59.97", "tax_total": "4.50", "grand_total": "64.47",
  "cancellation_reason": null, "created_at": "…", "updated_at": "…" }
```
Items store the historical name/price/tax snapshot (D-07), so a later catalog
edit never changes a past order (AC-ORD-06). Totals are server-derived
integer-cent math (D-09); a client-supplied price is rejected (`400`).

#### `POST /api/orders` — customer
Headers: `Idempotency-Key: <uuid>` **required**. Body is **strict**: either `{}`
(order the caller's cart) or `{ "items": [ { "product_id": "…", "quantity": 3 } ] }`
(explicit lines). No prices or customer id accepted.
```jsonc
// 201 → Order object (status pending, stock reserved, cart emptied, audit row)
// Replay of the SAME key with the SAME lines (same user): 200 with the stored
//   original body plus "idempotent": true — no second order, no second
//   reservation (AC-ORD-04).
// errors: 400 MISSING_IDEMPOTENCY_KEY · 400 VALIDATION_ERROR (bad UUID / qty / price)
//         · 401 · 403 FORBIDDEN_ROLE (only a customer may create)
//         · 404 PRODUCT_NOT_FOUND (unknown OR inactive line — FR-CAT-08)
//         · 409 INSUFFICIENT_STOCK (any short line rolls back the WHOLE order and
//           reserves nothing; `details.items` lists offenders — AC-ORD-02/03)
//         · 409 DUPLICATE_REQUEST (concurrent in-progress duplicate)
//         · 409 IDEMPOTENCY_CONFLICT (key reused for a DIFFERENT request)
//         · 422 EMPTY_CART · 400 (a merged line qty > 1000)
{ "error": { "code": "INSUFFICIENT_STOCK",
             "message": "Insufficient stock for 1 item(s)",
             "details": { "items": [ { "product_id": "…", "product_name": "Widget 100",
                                        "requested": 3, "available": 2 } ] } } }
```

**Idempotency contract (D-08):** the key is owned per `(user_id, idempotency_key)`
backed by a UNIQUE index, and the claim row is committed **before** any stock
work. A completed key replays its stored response; an in-progress key returns
`409 DUPLICATE_REQUEST`; a failed claim is reusable. Request matching uses a
SHA-256 `request_hash` of the normalized (deduped, product-id-sorted) lines — a
reused key with a different fingerprint returns `409 IDEMPOTENCY_CONFLICT`.

**Concurrency (R-01 / AC-ORD-05):** inventory rows are locked with
`SELECT … FOR UPDATE` one product at a time in ascending product-id order, so
last-unit races serialize without deadlock; the reservation/available `CHECK`s
are the final oversell guard. Availability is always re-verified server-side — a
prior cart or front-end check is never trusted.

#### `GET /api/orders` — any authenticated; customer sees **own only**, staff see all
Query: `?status=<lifecycle>&customer_id=<staff only>&page=&limit=` → `200`
`{ "data": [ … ], "meta": { page, limit, total } }`, newest first.

#### `GET /api/orders/:id` and `GET /api/orders/:id/items` — staff (any); customer (own only)
```jsonc
// 200 → Order object / items array
// errors: 401 · 404 ORDER_NOT_FOUND  // returned for another customer's order too
//   (FR-ORD-11 — 404 not 403, so existence is never leaked)
```

#### `PATCH /api/orders/:id/status` — admin, agent only
```jsonc
// request { "status": "confirmed" | "processing" | "shipped" | "delivered" }
// 200 → updated Order object. Only the single forward edge of the chain is legal.
//   Moving to 'shipped' consumes the reservation ONCE (physical -= qty AND
//   reserved -= qty) and writes a 'fulfillment_consumption' movement.
// errors: 400 VALIDATION_ERROR ('pending'/unknown value; 'cancelled' is rejected
//   here — use cancel) · 401 · 403 FORBIDDEN_ROLE (a customer cannot change status)
//   · 404 ORDER_NOT_FOUND · 409 INVALID_STATE_TRANSITION (a skip / backward / terminal
//   move, or a reservation no longer intact at ship time)
```

#### `POST /api/orders/:id/cancel` — **distinct operation**; any authenticated (customer own, staff any)
```jsonc
// request { "reason": "no longer needed" }   // reason required, min 3 chars
// 200 → updated Order (status "cancelled" + cancellation_reason; the reservation is
//   released EXACTLY once — a 'cancellation_release' movement — FR-ORD-08)
// errors: 400 VALIDATION_ERROR (missing/short reason) · 401 · 404 ORDER_NOT_FOUND
//   · 409 INVALID_STATE_TRANSITION (order not cancellable — already shipped /
//   delivered / cancelled, so it can never double-release or undo a consumption)
```
*Every order write records its change (`ORDER_CREATED` / `ORDER_STATUS_CHANGED` /
`ORDER_CANCELLED`) in the same transaction (append-only `audit_logs`).*

### 2.5 Invoices (as-built, Phase 8)

An invoice is the financial document of a **shipped** order. It is minted *inside
the same transaction that consumes stock at `→ shipped`*, so it can never exist
for an order that did not ship and never twice for one that did
(`invoices.order_id` is `UNIQUE`; a concurrent duplicate ship replays the winner).
Amounts are copied from the **order's persisted snapshot** — never recomputed
from the live catalog and never taken from a client body — so a later price/name
edit cannot alter an issued invoice (D-07 / AC-INV-01). Lifecycle is
`issued → voided` (voided is terminal, staff-only, and **preserves** the row;
there is no `paid` state because settlement is out of scope, requirements §3.2).
Because an order can only be cancelled *pre-shipment*, a cancelled order simply
has **no invoice**. Numbers are `INV-YYYY-NNNNNN` drawn from a per-year counter
race-safely (D-10). **Every invoice read is ownership-scoped**: a customer sees
only invoices of their own orders and a foreign id returns `404` (never `403`).

#### `GET /api/invoices` — customer (own) · admin/agent (all)
Query: `status` (`issued|voided`), `customer_id` (staff only), `page`, `limit`.
```jsonc
// 200
{ "data": [ { "id": "…", "invoice_number": "INV-2026-000042", "order_id": "…",
              "order_status": "shipped", "status": "issued", "issued_date": "2026-10-21",
              "customer_id": "…", "customer_name": "Buyer Co",
              "subtotal": "59.97", "tax_total": "4.50", "grand_total": "64.47" } ],
  "meta": { "page": 1, "limit": 20, "total": 1 } }
```

#### `GET /api/invoices/:id` — same scoping; a foreign/absent id → `404 INVOICE_NOT_FOUND`
#### `GET /api/orders/:id/invoice` — convenience lookup by order (same ownership rule)
```jsonc
// 200 — the full printable payload (nested customer + line snapshot + branding)
{ "id": "…", "invoice_number": "INV-2026-000042", "order_id": "…",
  "order_status": "shipped", "status": "issued", "issued_by": "…", "issued_date": "2026-10-21",
  "void_reason": null, "voided_at": null,
  "customer": { "id": "…", "name": "Buyer Co", "email": "buyer@example.test" },
  "items": [ { "id": "…", "product_name": "Widget 100", "quantity": 3,
               "unit_price": "19.99", "line_total": "59.97" } ],
  "subtotal": "59.97", "tax_total": "4.50", "grand_total": "64.47",
  "distributor": { "name": "B2B OMS Demo Distributor", "tagline": "…", "address_lines": ["…"],
                   "contact": "billing@b2boms.test", "tax_registration": "N/A — simulation" },
  "document_kind": "invoice", "demo": true,
  "demo_notice": "DEMONSTRATION DOCUMENT … NOT a legal tax invoice …" }
// errors: 401 · 400 VALIDATION_ERROR (bad id) · 404 INVOICE_NOT_FOUND
```

#### `POST /api/invoices/:id/void` — ADMIN / ORDER_MANAGER only (the sole write)
Body `{ "reason": "…" }` (3–500 chars, strict). Flips `issued → voided`, **never
alters totals**, and writes an `INVOICE_VOIDED` audit row. A re-void → `409
INVALID_STATE_TRANSITION`; a customer → `403 FORBIDDEN_ROLE`.
```jsonc
// 200 → the same printable payload with status "voided", void_reason, voided_at
// errors: 401 · 403 FORBIDDEN_ROLE · 400 · 404 · 409 INVALID_STATE_TRANSITION
```

*Invoices are rendered as JSON-driven, print-stylesheet UI views (Print / Save-as-PDF via the browser, no PDF library); real fiscal/PDF compliance is out of scope (`requirements.md` §3.2, D-25). The document is always labelled a demonstration because this is a simulated business.*

### 2.6 Audit (admin only, as-built Phase 9)

> The trail is **append-only and READ-ONLY**: `audit_logs` has a DB `BEFORE UPDATE/DELETE`
> trigger (migration 11) and there is **no** create/update/delete route anywhere in the
> API — history cannot be altered or removed, by admins included (FR-AUD-02). Rows are
> written **inside the same transaction** as the business change they describe (NFR-13),
> so a rolled-back write leaves no row. Every row carries an `outcome` (`success` | `failure`,
> migration 18): committed business writes are `success`; `failure` is reserved for
> security-relevant attempts with no data change (a rejected login). `details` is a small
> allow-list JSONB — **never** a password, JWT, auth header or unnecessary PII.

#### `GET /api/audit-logs` — ADMIN only
Query: `?actor_id=&action=&entity_type=&entity_id=&outcome=&from=&to=&page=&limit=`
(all enums/date-bounds validated by a strict Zod schema; a bad value → 400)
```jsonc
// 200 — newest first; actor identity is LEFT-joined (failed logins have no actor_id)
{ "data": [ { "id": "…", "actor_id": "…", "actor_role": "agent",
              "actor_email": "ops@…", "actor_name": "Ops Person",
              "action": "ORDER_STATUS_CHANGED", "entity_type": "order", "entity_id": "…",
              "details": { "from": "processing", "to": "shipped" },
              "outcome": "success", "created_at": "2026-10-21T10:12:00Z" } ],
  "meta": { "page": 1, "limit": 25, "total": 1240 } }
// errors: 401 · 403 FORBIDDEN_ROLE (non-admin) · 400 VALIDATION_ERROR (bad filter/date)
```
*Audited actions (single source of truth — `backend/src/constants/audit.js`):*
`USER_REGISTERED · LOGIN_SUCCESS · LOGIN_FAILED · ACCOUNT_DISABLED_ATTEMPT · AUTH_TOKEN_REUSED · USER_ROLE_CHANGED · USER_STATUS_CHANGED · PRODUCT_CREATED/UPDATED/ACTIVATED/DEACTIVATED · STOCK_ADJUSTED/RESERVED/RELEASED/CONSUMED · CART_ITEM_ADDED/UPDATED/REMOVED · CART_EMPTIED · ORDER_CREATED/STATUS_CHANGED/CANCELLED · INVOICE_ISSUED/VOIDED`.

### 2.7 Reports & dashboard (as-built Phase 9)

> Every figure is derived **only from stored rows** — nothing is estimated or fabricated.
> **Order value is NOT revenue:** the platform never captures payment (requirements §3.2),
> so what is reported is **`booked_order_value`** = SUM(grand_total) over **non-cancelled**
> orders in the window (demand booked, not money collected). No revenue figure is emitted.
> Low-stock is an **instantaneous snapshot** (`available_quantity <= low_stock_threshold`).
> The full dashboard (which embeds the audit activity feed) is **ADMIN-only**; the order
> summary and low-stock report are the **ADMIN + ORDER_MANAGER** staff view, identical
> metrics **minus** the who-did-what history (FR-AUD-03).

#### `GET /api/reports/dashboard` — ADMIN
Query: `?from=&to=` (optional window on `orders.created_at`; absent → trailing 30 days)
```jsonc
// 200
{ "data": { "audience": "admin", "generated_at": "…", "window": { "from": "…", "to": null, "days": 30 },
  "totals": { "total_orders": 12, "cancelled_orders": 2, "active_orders": 10,
              "booked_order_value": "429.80", "gross_value_including_cancelled": "500.00" },
  "orders_by_status": { "pending": 1, "confirmed": 2, "processing": 3, "shipped": 2, "delivered": 2, "cancelled": 2 },
  "low_stock": { "count": 4 },
  "recent_orders": [ { "id": "55", "customer_id": "3", "status": "shipped", "grand_total": "42.98", "created_at": "…" } ],
  "audit": { "total_events": 137, "recent_activity": [ /* newest audit_logs rows */ ] },
  "metric_definitions": { "booked_order_value": "… not collected revenue …", "limitations": "…" } } }
// errors: 401 · 403 FORBIDDEN_ROLE · 400 VALIDATION_ERROR (bad window)
```

#### `GET /api/reports/order-summary` — ADMIN + ORDER_MANAGER
```jsonc
// 200 — the SAME order/inventory metrics as the dashboard, WITHOUT the `audit` block
// errors: 401 · 403 FORBIDDEN_ROLE (customer) · 400
```

#### `GET /api/reports/low-stock` — ADMIN + ORDER_MANAGER
Query: `?search=&page=&limit=`
```jsonc
// 200 { "data": [ /* inventory rows genuinely at/below threshold */ ], "meta": {…} }
// errors: 401 · 403 · 400
```

### 2.8 Health

#### `GET /health` — public (infra endpoint, not under `/api`)
```jsonc
// 200 { "status": "ok", "db": "up", "uptime": 123.4 }
// 503 { "status": "degraded", "db": "down" }
```

## 3. Error model

Every non-2xx response uses one shape (produced centrally by `errorHandler`):

```json
{ "error": { "code": "INSUFFICIENT_STOCK",
             "message": "Human-readable, safe to display",
             "details": { } } }
```

| Code | HTTP | Meaning / typical trigger |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod schema failure; `details.fields = [{path, message}]` |
| `MISSING_IDEMPOTENCY_KEY` | 400 | `POST /api/orders` without header |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired JWT or deactivated user |
| `INVALID_CREDENTIALS` | 401 | Login failure (uniform message) |
| `FORBIDDEN_ROLE` | 403 | Authenticated but role not permitted |
| `NOT_FOUND` | 404 | Generic route mismatch |
| `USER_NOT_FOUND` / `PRODUCT_NOT_FOUND` / `CART_ITEM_NOT_FOUND` / `ORDER_NOT_FOUND` / `INVOICE_NOT_FOUND` | 404 | Resource missing **or** belongs to another customer (deliberate 404-not-403, FR-ORD-11) |
| `DUPLICATE_EMAIL` / `DUPLICATE_SKU` | 409 | Unique constraint conflict |
| `INSUFFICIENT_STOCK` | 409 | Order or adjustment would go negative; order case lists offending lines |
| `CART_LINE_LIMIT_EXCEEDED` | 409 | Cart line (merged/set) exceeds the documented per-line max (1000) |
| `PRODUCT_UNAVAILABLE` | 409 | Cart line PATCH targets a product deactivated after being added |
| `INVALID_STATE_TRANSITION` | 409 | Illegal order status change (skip/backward/terminal, or a non-cancellable cancel) |
| `DUPLICATE_REQUEST` | 409 | Concurrent second request with same in-progress idempotency key |
| `IDEMPOTENCY_CONFLICT` | 409 | Reused `Idempotency-Key` whose `request_hash` differs from the stored request |
| `SELF_ROLE_CHANGE_NOT_ALLOWED` / `SELF_DEACTIVATION_NOT_ALLOWED` | 409 | `PATCH /api/users/:id` self-lockout guard — an admin cannot demote or deactivate their own account |
| `EMPTY_CART` | 422 | Order submitted with no cart lines |
| `RATE_LIMITED` | 429 | Rate limiter tripped (login/global) |
| `INTERNAL_ERROR` | 500 | Unhandled; body carries only a generic message + `details.request_id`; original error logged server-side without secrets |

## 4. Status-code summary per operation class

| Operation | Success | Validation | AuthZ | Conflict | Other |
|---|---|---|---|---|---|
| Login | 200 | 400 | 401 | — | 429 |
| Create (user/product/order/adjustment/cart-item; invoice auto-mints on ship) | 201 | 400 | 401/403 | 409 | 422 (order) |
| Read (lists/details) | 200 | 400 (bad query) | 401/403 | — | 404 |
| Update/transition (PUT/PATCH/POST action) | 200 | 400 | 401/403 | 409 | — |
| Delete cart / cart item | 204 / 200 | — | 401/403 | — | 404 |

## 5. Endpoint → requirement map (for traceability completeness)

| Endpoint group | Requirements | Acceptance criteria |
|---|---|---|
| `/api/auth/*`, `/api/users*` | FR-AUTH-01…07, NFR-01/04 | AC-AUTH-01…07 |
| `/api/products*` | FR-CAT-01…05, FR-CAT-08 | AC-CAT-01…03, AC-CAT-06…07 |
| `/api/products/:id/inventory/*` | FR-CAT-06/07 | AC-CAT-04/05 |
| `/api/cart*` | FR-CART-01…05 | AC-CART-01…05 |
| `/api/orders*` | FR-ORD-01…11 | AC-ORD-01…08, AC-LIF-01…06 |
| `/api/invoices*` | FR-INV-01…05 | AC-INV-01…04 |
| `/api/audit-logs` | FR-AUD-01…03/05 | AC-AUD-01…03 |
| `/api/reports/dashboard` · `/order-summary` · `/low-stock` | FR-AUD-05 (dashboard), role-scoped reporting | Admin/agent scoping + aggregation-accuracy integration tests |
| `/health` | FR-AUD-04, NFR-12 | NFR-DEPLOY-01 |
