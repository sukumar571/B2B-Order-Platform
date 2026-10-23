# Acceptance Criteria — B2B Order Management Platform

**Document version:** 1.0 (Phase 1 — Planning & Design)
**Status:** Draft for review. **No results in this document have been measured yet** — every criterion below defines *how* success will be verified in Phases 2–4 and what evidence must be produced.

Conventions:
- Each AC maps to requirement IDs from `requirements.md`.
- **Priority:** `Must` (release-blocking) / `Should` (expected, negotiable under time pressure with logged deviation).
- **Verification method:** `Unit` (unit test), `Int` (backend integration test via Node test runner + Supertest + test DB), `E2E` (Playwright), `Manual` (recorded checklist), `Load` (scripted k6/artillery-style concurrency test using the Express app against the compose PostgreSQL).

---

## 1. Authentication & Users

| ID | Priority | Acceptance criterion (Given/When/Then) | Verification | Maps to |
|---|---|---|---|---|
| AC-AUTH-01 | Must | **Given** a seeded user `admin@test.local` with correct password, **when** `POST /api/auth/login` is called, **then** the response is `200` with a JWT and user object `{id, name, role}` and **no** password field. | Int | FR-AUTH-01 |
| AC-AUTH-02 | Must | **Given** any login attempt with wrong email or wrong password, **when** submitted, **then** the response is `401 INVALID_CREDENTIALS` with identical messaging for both failure causes. | Int | FR-AUTH-02 |
| AC-AUTH-03 | Must | **Given** a created user, **when** its DB row is read directly, **then** `password_hash` starts with `$2` (bcrypt) and the plaintext password appears nowhere in the row, logs, or responses. | Int, Manual log grep | FR-AUTH-03, NFR-01 |
| AC-AUTH-04 | Must | **Given** no token, an expired token, or a token signed with a wrong secret, **when** calling any protected endpoint, **then** each returns `401 UNAUTHORIZED`. | Int | FR-AUTH-04 |
| AC-AUTH-05 | Must | **Given** an admin, **when** creating a user with an email that already exists, **then** `409 DUPLICATE_EMAIL`; **when** creating with a valid unique email, **then** `201` and the user can log in. | Int | FR-AUTH-05 |
| AC-AUTH-06 | Must | **Given** a deactivated user with a previously issued valid-format JWT, **when** calling a protected endpoint, **then** `401` (token rejected because the user is disabled — user is re-checked per request or via token version). | Int | FR-AUTH-06 |
| AC-AUTH-07 | Should | **Given** a customer, **when** calling `POST /api/users` (admin-only), **then** `403 FORBIDDEN_ROLE`. | Int | NFR-04 |

## 2. Products & Inventory

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| AC-CAT-01 | Must | **Given** an admin with valid payload, **when** creating a product, **then** `201` and `GET /api/products/:id` returns the same values including `available_stock` = initial stock. | Int | FR-CAT-01 |
| AC-CAT-02 | Must | **Given** product price `0`, `-5`, `"abc"`, or tax rate `101`, **when** creating/updating, **then** `400 VALIDATION_ERROR` with field-level messages from Zod. | Int, Unit | FR-CAT-01, C-04 |
| AC-CAT-03 | Must | **Given** existing SKU `X`, **when** creating a second product with SKU `X`, **then** `409 DUPLICATE_SKU` (and a DB unique-index violation is never surfaced as a 500). | Int | FR-CAT-03 |
| AC-CAT-04 | Must | **Given** inventory `50`, **when** an agent applies adjustment `-20` with reason, **then** stock is `30`, an `inventory_movements` row `(-20, reason)` exists, and an audit row exists. | Int | FR-CAT-06 |
| AC-CAT-05 | Must | **Given** inventory `10`, **when** adjusting by `-15`, **then** `409 INSUFFICIENT_STOCK` and stock remains `10`. | Int | FR-CAT-07 |
| AC-CAT-06 | Must | **Given** a product deactivated by admin, **when** a customer lists products and tries `POST /api/cart/items` for it, **then** it is absent from the list (default `active_only=true`) and the add returns `404 PRODUCT_NOT_FOUND`. | Int | FR-CAT-08 |
| AC-CAT-07 | Should | **Given** 55 products, **when** listing with `page=2&limit=25`, **then** exactly 25 correctly-offset items are returned with total count metadata. | Int | FR-CAT-04 |

## 3. Cart

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| AC-CART-01 | Must | **Given** a cart containing product P qty 2, **when** the customer adds P qty 3 again, **then** one line exists with qty 5 (no duplicate row). | Int | FR-CART-01 |
| AC-CART-02 | Must | **Given** cart lines with known prices, **when** `GET /api/cart`, **then** server returns per-line `line_total`, `subtotal`, `tax_total`, `grand_total` satisfying `grand_total = subtotal + tax_total` to the cent for values like `19.99 × 3 @ 7.5%` (exact expected value asserted: subtotal 59.97, tax 4.50 [half-up], grand 64.47). | Int, Unit | FR-CART-03, NFR-07 |
| AC-CART-03 | Must | **Given** requested qty exceeds available stock, **when** viewing the cart, **then** the line carries `available_now` and a warning flag, and stock has **not** changed (no reservation at cart time). | Int | FR-CART-04 |
| AC-CART-04 | Must | **Given** qty `0` or `-1`, **when** adding/updating a line, **then** `400 VALIDATION_ERROR`. | Int | FR-CART-02 |
| AC-CART-05 | Should | **Given** a customer's cart, **when** another customer calls `DELETE /api/cart` or reads `GET /api/cart` with their own token, **then** each sees only their own cart (cross-user isolation). | Int | NFR-04 |

## 4. Orders — creation, stock, idempotency

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| AC-ORD-01 | Must | **Given** cart (2 × `19.99`, stock 10) and an `Idempotency-Key`, **when** `POST /api/orders`, **then** `201` with order `pending`, stock now 8, cart emptied, `order_items` snapshot name/price recorded, and audit row `ORDER_CREATED`. | Int | FR-ORD-01/02/04, FR-CART-05 |
| AC-ORD-02 | Must | **Given** two lines, one with sufficient and one with insufficient stock, **when** ordering, **then** `409 INSUFFICIENT_STOCK` naming the failing product, **and** neither line's stock changed and no order row exists (full rollback). | Int | FR-ORD-02/03, NFR-06 |
| AC-ORD-03 | Must | **Given** client-submitted totals that differ from server prices, **when** included in the request, **then** the server ignores them and uses its own computed values (assert stored totals = server computation). | Int | FR-ORD-01 |
| AC-ORD-04 | Must | **Given** the same `Idempotency-Key` and same user, **when** `POST /api/orders` is sent twice (including parallel double-send with 100 ms stagger), **then** exactly one order exists, stock decremented once, and the second response returns the original order `200 {idempotent: true}`. | Int, Load | FR-ORD-06 |
| AC-ORD-05 | Must | **Given** product stock = 5, **when** 20 concurrent customers each try to order qty 1, **then** exactly 5 succeed, 15 receive `409 INSUFFICIENT_STOCK`, final stock = 0, and no negative or oversold value occurs. | Load (10 repeated runs) | FR-ORD-02, SC-02 |
| AC-ORD-06 | Must | **Given** an existing order, **when** admin changes the product's price/name afterward, **then** the order's stored item name/price/totals are byte-identical to before the edit. | Int | FR-ORD-04 |
| AC-ORD-07 | Must | **Given** an order with missing `Idempotency-Key` header, **when** submitted, **then** `400 MISSING_IDEMPOTENCY_KEY`. | Int | FR-ORD-06 |
| AC-ORD-08 | Should | **Given** an empty cart, **when** ordering, **then** `422 EMPTY_CART`. | Int | FR-ORD-01 |

## 5. Orders — lifecycle

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| AC-LIF-01 | Must | **Given** a `pending` order, **when** an agent confirms it, **then** status `confirmed`; **when** the same agent fulfills it, **then** status `fulfilled` and exactly one invoice exists. | Int | FR-ORD-07/09 |
| AC-LIF-02 | Must | **Given** a `pending` order, **when** fulfilled directly, **then** `409 INVALID_STATE_TRANSITION` (confirm must precede fulfill). | Int | FR-ORD-10 |
| AC-LIF-03 | Must | **Given** a `fulfilled` order, **when** cancelled, **then** `409 INVALID_STATE_TRANSITION` and stock unchanged. | Int | FR-ORD-07/08 |
| AC-LIF-04 | Must | **Given** a `confirmed` order with stock available = A, **when** the customer cancels with a reason, **then** status `cancelled`, reason recorded, and available stock becomes A + ordered qty in the same transaction. | Int | FR-ORD-08 |
| AC-LIF-05 | Must | **Given** customer C1 and order of customer C2, **when** C1 calls cancel or detail endpoints for C2's order, **then** `404 ORDER_NOT_FOUND` (no existence leak) and C2's order state is untouched. | Int | FR-ORD-11 |
| AC-LIF-06 | Should | **Given** a `cancelled` order, **when** any transition (confirm/fulfill/cancel) is attempted, **then** `409 INVALID_STATE_TRANSITION`. | Int | FR-ORD-07 |

## 6. Invoices

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| AC-INV-01 | Must | **Given** an order (subtotal S, tax T, grand G), **when** fulfilled, **then** invoice exists with line items matching `order_items` snapshots and `invoice.total = G` exactly; `S + T = G` asserted. | Int | FR-INV-01/03 |
| AC-INV-02 | Must | **Given** two fulfillments in sequence within a month, **when** invoices are created, **then** numbers follow `INV-YYYY-NNNNNN` with strictly increasing NNNNNN and a DB unique constraint on `invoice_number`. | Int | FR-INV-02 |
| AC-INV-03 | Must | **Given** a forced duplicate-invoice attempt (raw SQL bypassing service), **when** inserting a second invoice for the same `order_id`, **then** the unique constraint rejects it at the DB level. | Int | FR-INV-05 |
| AC-INV-04 | Should | **Given** a customer, **when** calling `GET /api/invoices` (list), **then** only their own invoices are returned; an agent receives all. | Int | FR-INV-04 |

## 7. Audit

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| AC-AUD-01 | Must | **Given** scripted flows for login-fail, product-create, stock-adjust, order-create, confirm, cancel, fulfill, **when** each completes, **then** `audit_logs` contains one entry per event with actor ID/role, action name, entity, timestamp, and JSON details. | Int | FR-AUD-01 |
| AC-AUD-02 | Must | **Given** any audit entry or application log line, **when** grepping the test-run log output, **then** no string equals a test password, JWT secret, or a full JWT token value used in the run. | Manual log grep + CI grep step | FR-AUD-05, NFR-01 |
| AC-AUD-03 | Should | **Given** the audit endpoints, **when** a non-admin role requests `GET /api/audit-logs`, **then** `403 FORBIDDEN_ROLE`; **then** no HTTP method exists to modify an audit row. | Int | FR-AUD-02/03 |

## 8. Non-functional acceptance

| ID | Priority | Acceptance criterion | Verification | Maps to |
|---|---|---|---|---|
| NFR-SEC-01 | Must | **Given** hostile inputs (`' OR 1=1 --`, `"); DROP TABLE orders;--`, oversized 10 KB strings) in every text parameter, **when** replayed against all endpoints, **then** all requests either validate-fail (`400`) or are treated as literal data; DB schema and row counts unchanged. | Int (injection suite) | NFR-02 |
| NFR-SEC-02 | Must | **Given** the repository, **when** scanning tracked files (e.g., `gitleaks` or documented manual grep for `SECRET|PASSWORD|token` patterns), **then** zero real secrets found; only `.env.example` placeholders exist. | Manual/CI scan | NFR-03 |
| NFR-PERF-01 | Should | **Given** a seeded dataset (500 products, 200 customers, 1,000 orders), **when** running the 20 virtual-user load script for 2 minutes, **then** measured p95: reads ≤ 500 ms, order creation ≤ 1,500 ms; error rate (5xx) < 1%. Report must include **measured** numbers and hardware/Docker context. | Load | NFR-05 |
| NFR-DEPLOY-01 | Must | **Given** a machine with only Docker Desktop installed and a cloned repo, **when** running `docker compose up --build`, **then** within 60 s `GET /health` returns `{"status":"ok","db":"up"}`; migrations applied to empty volume; `docker compose down && up` preserves data (named volume). | Manual checklist, scripted | NFR-12/14 |
| NFR-TEST-01 | Must | **Given** a fresh clone, **when** running `npm test` (backend) and `npm run test:frontend`, **then** all suites pass; backend coverage report shows ≥ 80% lines for `services/` order/inventory/pricing modules, with the actual percentage recorded in the Phase report. | CI run | NFR-11 |
| NFR-USE-01 | Should | **Given** a scripted walkthrough, **when** counting UI interactions for login→browse→cart→order and staff confirm→fulfill→invoice, **then** each is ≤ 5 steps; screenshots attached to the phase report. | Manual | NFR-08 |

## 9. Release definition (project-level)

A phase may be called complete only when:

1. Every `Must` AC mapped to it is verified with linked evidence (test name + run output or report artifact).
2. Every `Should` AC is either verified or has a logged deviation entry in `decision-log.md`.
3. Full automated suites pass with zero failures; any environment limitation (e.g., load test skipped on host hardware) is **documented as not-measured**, never reported as passing.
4. `risk-register.md` has been reviewed and updated with newly discovered risks.
5. Docs in `docs/` match the implemented behavior (no drift).

## 10. Honesty constraints

- This document asserts **no** test results, performance figures, or security findings. All tables above are verification *plans*.
- Metrics quoted (e.g., AC-CART-02 expected totals) are hand-computed arithmetic fixtures, not measurements.
- Any claim of "passed" for an AC must be recorded in a phase report with the command run, date, and output summary.
