# Requirements Specification — B2B Order Management Platform

**Document version:** 1.0 (Phase 1 — Planning & Design)
**Status:** Draft for review — no application features implemented yet.
**Related documents:** `acceptance-criteria.md`, `architecture.md`, `database-design.md`, `api-specification.md`, `decision-log.md`, `implementation-plan.md`, `risk-register.md`

---

## 1. Business Problem

Distributors who sell to business customers (retailers, resellers, B2B buyers) currently manage orders through email threads, spreadsheets, and phone calls. This causes:

- **Order errors:** manual re-entry of product codes and quantities leads to wrong items, wrong prices, and incorrect totals.
- **Overselling:** stock levels are tracked in spreadsheets that are updated after the fact, so customers are promised inventory that no longer exists.
- **Slow invoice cycles:** invoices are generated manually days after fulfillment, delaying payment.
- **No audit trail:** when disputes arise (price, quantity, cancellation), there is no reliable record of who did what and when.
- **Uncontrolled access:** shared spreadsheets and inboxes cannot restrict what each user role may see or change.

The B2B Order Management Platform replaces this with a single web application where customers place validated orders against real-time stock, distributors manage catalog and fulfillment, and every state change is audited and invoiced automatically.

## 2. Stakeholders

| Stakeholder | Role in the system | Primary needs |
|---|---|---|
| **Distributor (business owner)** | Operates the platform for their sales operation | Accurate stock, no overselling, complete order and invoice records, staff permission control |
| **Distributor staff — Admin** | Manages catalog, users, and system settings | Create/deactivate users, manage products and inventory, view all data |
| **Distributor staff — Sales/fulfillment agent** | Processes orders | View incoming orders, confirm/cancel/fulfill, generate invoices |
| **B2B Customer (buyer)** | Places orders for their business | Browse catalog, see true availability, build a cart, submit orders, track status, download invoices |
| **Developer / DevOps** | Builds and runs the system | Reproducible setup (Docker), tests, documented contracts |
| **Auditor / dispute resolver** | Investigates history | Immutable-ish audit log with actor, action, timestamp |

## 3. Scope Boundaries

### 3.1 In scope (Phase 1–2 delivery)

- Role-based authentication (JWT) with three roles: `admin`, `agent` (distributor staff), `customer`.
- Product catalog management (CRUD by admin; read by authenticated users).
- Inventory tracking per product with transactional, row-locked reservation at order creation (prevents overselling).
- Per-customer shopping cart (add / update / remove items, view totals).
- Order creation from cart with stock validation, price snapshotting, and idempotency keys.
- Order lifecycle: `pending → confirmed → fulfilled` and cancellation from `pending`/`confirmed` with stock release.
- Automatic invoice generation on fulfillment with sequential invoice numbers.
- Audit log of security- and order-relevant events.
- Web UI (React) for browsing, cart, orders, admin catalog/inventory, and invoice views.
- Dockerized deployment (API + PostgreSQL) and automated test suites.

### 3.2 Out of scope (explicitly deferred)

- Online payment processing / gateways (invoices record amounts only; settlement is offline).
- Shipping/carrier integration and logistics tracking.
- Multi-warehouse or batch/lot inventory.
- Purchase orders from distributors to their suppliers (platform covers sales side only).
- Taxes other than a single configurable percentage per product.
- Discounts, promotions, credit limits, and negotiated per-customer price lists (base price per product only in v1).
- Reporting dashboards/BI, CSV export.
- Localization, theme customization, mobile-native apps.
- Customer self-service registration (admin creates customer accounts).

## 4. Personas and Role Permissions

| Capability | admin | agent | customer |
|---|---|---|---|
| Login / view own profile | ✔ | ✔ | ✔ |
| Create/deactivate users | ✔ | ✖ | ✖ |
| Create/update/deactivate products | ✔ | ✖ | ✖ |
| Adjust inventory levels | ✔ | ✔ | ✖ |
| View all orders | ✔ | ✔ | ✖ |
| View own orders | ✔ | ✔ | ✔ |
| Confirm/cancel/fulfill orders | ✔ | ✔ | ✖ |
| Cancel own order (pending/confirmed only) | ✖ | ✖ | ✔ |
| Manage own cart | ✖ | ✖ | ✔ |
| View/download invoices | ✔ (all) | ✔ (all) | ✔ (own) |
| View audit logs | ✔ | ✖ | ✖ |

## 5. Inputs and Outputs

### 5.1 Inputs

- Authenticated user credentials (email + bcrypt-hashed password).
- Product records: name, SKU, description, unit price, tax rate, active flag.
- Inventory adjustments: product, quantity delta, reason.
- Cart operations: product ID, quantity.
- Order submission: cart contents (server-side re-read), client-generated idempotency key.
- Order state transitions: confirm / cancel (with reason) / fulfill by staff.
- Admin-created customer and staff accounts.

### 5.2 Outputs

- Authenticated sessions (JWT access tokens).
- Catalog and availability listings.
- Cart with line totals and grand total.
- Orders with status history and snapshotted item prices/names.
- Invoices (numbered, dated, with tax and total breakdown).
- Audit log entries visible to admins.
- Structured JSON error responses with stable error codes (see `api-specification.md`).

## 6. Constraints

| # | Constraint |
|---|---|
| C-01 | Frontend must be React + Vite (JavaScript, HTML, CSS); no TypeScript or other frontend frameworks. |
| C-02 | Backend must be Node.js + Express (JavaScript) with layered structure: routes → middleware → controllers → services → repositories → PostgreSQL. |
| C-03 | Database must be PostgreSQL; migrations managed with `node-pg-migrate`. All money values stored as `NUMERIC`. |
| C-04 | All input validation via Zod at the route boundary; all SQL parameterized — no string interpolation of values. |
| C-05 | Auth: JWT bearer tokens + bcrypt password hashing. RBAC enforced on every backend endpoint; frontend route guards are convenience only. |
| C-06 | Secrets (DB credentials, JWT signing key) supplied only via environment variables; never committed. |
| C-07 | Deployment via Dockerfile + `docker-compose.yml` (API + PostgreSQL services). |
| C-08 | Testing: Node test runner + Supertest (backend), Vitest + React Testing Library (frontend), Playwright (E2E). |
| C-09 | Target platform for local development is Windows; WSL2/Docker Desktop available. |
| C-10 | Single distributor tenant (single organization); no multi-tenant isolation required in v1. |

## 7. Assumptions

- A-01: One distributor operates the system for its own sales team and customer base (single-tenant, C-10).
- A-02: Inventory quantity is a single on-hand integer per product (no batches/locations).
- A-03: Prices are defined per product and are identical for all customers in v1.
- A-04: A customer's order is accepted or rejected as a whole (no partial acceptance by staff at creation time).
- A-05: Users accept that cancelled pending/confirmed orders free reserved stock immediately.
- A-06: Invoice delivery is by download from the UI; email delivery is deferred.
- A-07: Expected scale for v1 is modest (≤ ~500 products, ≤ ~200 active customers, ≤ ~1,000 orders/day); performance targets are set accordingly (see NFRs).

## 8. Functional Requirements

Each requirement is testable; IDs are referenced by `acceptance-criteria.md` and the traceability table in `implementation-plan.md`.

### 8.1 Authentication & Users (AUTH)

- **FR-AUTH-01:** The system shall authenticate users by email and password, issuing a JWT containing user ID, name, and role on success.
- **FR-AUTH-02:** The system shall reject invalid credentials with `401 INVALID_CREDENTIALS` without indicating which field was wrong.
- **FR-AUTH-03:** The system shall store passwords only as bcrypt hashes (cost factor ≥ 10) and never log or return them.
- **FR-AUTH-04:** The system shall reject requests with missing, expired, malformed, or signed-out JWTs with `401 UNAUTHORIZED`.
- **FR-AUTH-05:** Admins shall create staff (`agent`) and `customer` accounts with an initial password; the system shall enforce unique email addresses.
- **FR-AUTH-06:** Admins shall deactivate (disable) users; deactivated users shall be unable to log in, and their existing tokens shall be rejected.
- **FR-AUTH-07:** Any authenticated user shall be able to view their own profile (`GET /api/auth/me`).

### 8.2 Products & Inventory (CAT)

- **FR-CAT-01:** Admins shall create products with name, unique SKU, description, unit price (> 0), tax rate (0–100), and active flag.
- **FR-CAT-02:** Admins shall update products and deactivate them (soft delete); the system shall retain products referenced by existing orders (snapshot integrity is independent, but references must not break).
- **FR-CAT-03:** The system shall reject a product create/update whose SKU duplicates an existing product with `409 DUPLICATE_SKU`.
- **FR-CAT-04:** Authenticated users shall list products with pagination and search by name/SKU, and shall see `available_stock` per product.
- **FR-CAT-05:** Authenticated users shall view a single product's details by ID.
- **FR-CAT-06:** Admins and agents shall adjust inventory with a signed quantity delta and a reason; the system shall record each adjustment in `inventory_movements` and in the audit log.
- **FR-CAT-07:** The system shall never allow on-hand stock to go below zero; an adjustment that would cause a negative result shall be rejected with `409 INSUFFICIENT_STOCK`.
- **FR-CAT-08:** Deactivated products shall not appear in customer-facing listings and shall not be addable to carts.

### 8.3 Cart (CART)

- **FR-CART-01:** Each customer shall have exactly one active cart; adding an item already present shall increase its quantity rather than duplicate the line.
- **FR-CART-02:** The system shall reject adding inactive products or quantities < 1 with `400`/`404` per the API spec.
- **FR-CART-03:** Customers shall update line quantity, remove lines, and view the cart with per-line totals (current price × quantity), subtotal, tax, and grand total computed server-side.
- **FR-CART-04:** The system shall display availability warnings when requested quantity exceeds current available stock, but shall not reserve stock at cart time.
- **FR-CART-05:** Customers shall empty their cart; upon successful order creation the cart shall be emptied automatically.

### 8.4 Orders (ORD)

- **FR-ORD-01:** A customer shall create an order from their cart; the system shall re-read prices and stock server-side (never trusting client totals).
- **FR-ORD-02:** Order creation shall execute in a single PostgreSQL transaction that locks each affected inventory row (`SELECT … FOR UPDATE`), verifies `available_quantity ≥ requested`, decrements available stock (reservation), and writes order + order_items; any failure shall roll back with no stock change.
- **FR-ORD-03:** The system shall reject order creation if any line lacks stock with `409 INSUFFICIENT_STOCK`, listing the offending products, and shall leave all stock unchanged (atomicity).
- **FR-ORD-04:** `order_items` shall store the product name and unit price at order time (historical snapshot) so later catalog edits never alter past orders.
- **FR-ORD-05:** Order totals (subtotal, tax total, grand total) shall be computed server-side with exact decimal arithmetic and stored.
- **FR-ORD-06:** Order creation shall require an `Idempotency-Key` header; a repeated request with the same key (same user) shall return the original order with `200`, never create a second order or double-decrement stock.
- **FR-ORD-07:** Order status shall follow: `pending → confirmed → fulfilled`; `pending`/`confirmed` may transition to `cancelled`. `fulfilled` and `cancelled` are terminal.
- **FR-ORD-08:** Customers may cancel only their own orders in `pending` or `confirmed` status; agents/admins may cancel any order in those statuses. Cancellation shall release reserved stock (increment available) in one transaction.
- **FR-ORD-09:** Only agents/admins may confirm or fulfill orders. Fulfillment shall transition `confirmed → fulfilled` and trigger invoice generation atomically.
- **FR-ORD-10:** Invalid transitions (e.g., fulfilling a `pending` order, cancelling a `fulfilled` order) shall be rejected with `409 INVALID_STATE_TRANSITION`.
- **FR-ORD-11:** Agents/admins shall list and filter all orders (status, customer); customers shall list and view only their own orders. Unauthorized access to another customer's order shall return `404 ORDER_NOT_FOUND` (no existence leak).

### 8.5 Invoices (INV)

- **FR-INV-01:** On fulfillment the system shall create an invoice capturing the order's line items, prices, taxes, and totals as snapshotted at order time.
- **FR-INV-02:** Invoice numbers shall be unique, gap-tolerant, sequential per calendar period, generated atomically with invoice creation (e.g., `INV-2026-000001`).
- **FR-INV-03:** Invoice totals shall equal the corresponding order totals; this equality shall be asserted by tests.
- **FR-INV-04:** Agents/admins may view all invoices; customers may view only invoices for their own orders.
- **FR-INV-05:** Fulfillment shall be idempotent with respect to invoicing: an order shall have at most one invoice (DB unique constraint).

### 8.6 Audit & Observability (AUD)

- **FR-AUD-01:** The system shall record an audit entry (actor, action, entity type, entity ID, JSON details, timestamp) for: login success/failure, user create/deactivate, product create/update/deactivate, inventory adjustment, order create/confirm/cancel/fulfill, and invoice creation.
- **FR-AUD-02:** Audit entries shall be append-only through the application (no update/delete endpoints exist for them).
- **FR-AUD-03:** Admins shall query the audit log filtered by actor, action, entity, and date range.
- **FR-AUD-04:** The system shall expose a `GET /health` endpoint returning service and database status for Docker/compose health checks.
- **FR-AUD-05:** The system shall not write passwords, JWTs, or secret values to logs or audit details.

## 9. Non-Functional Requirements

- **NFR-01 (Security — transport of credentials):** Passwords are never returned in any API response body, logged, or stored in the frontend beyond the login form's transient state.
- **NFR-02 (Security — injection):** All SQL uses parameterized queries; a static review + test must show no template-string SQL with external input.
- **NFR-03 (Security — secrets):** All secrets come from environment variables; the repository contains only `.env.example` with placeholder values.
- **NFR-04 (Authorization integrity):** RBAC is enforced server-side on 100% of endpoints; tests cover one happy path and one forbidden-role case per endpoint group.
- **NFR-05 (Performance):** On the v1 assumed scale (A-07), read endpoints (catalog, cart, order list) shall respond with p95 ≤ 500 ms and order creation shall complete in ≤ 1,500 ms at 20 concurrent users in the load test defined in `acceptance-criteria.md` (to be measured in Phase 3 — target, not a claimed result).
- **NFR-06 (Reliability — atomicity):** No partial order may exist: any failure during order creation leaves stock and order tables unchanged (verified by rollback tests).
- **NFR-07 (Correctness — money):** All monetary arithmetic uses decimal-safe operations (integer cents or `NUMERIC` in DB; no float arithmetic on money in services). Stored totals must satisfy `grand_total = subtotal + tax_total` exactly.
- **NFR-08 (Usability):** Core flows (login → browse → cart → order; staff → confirm → fulfill → invoice) each achievable in ≤ 5 UI steps; pages show validation errors and loading states.
- **NFR-09 (Compatibility):** Works on latest Chrome/Edge desktop at ≥ 1280 px width.
- **NFR-10 (Maintainability):** Layered architecture per `architecture.md`; no file > ~400 lines; ESLint clean on `npm run lint`.
- **NFR-11 (Test coverage):** Backend integration tests cover all API endpoints and every FR-ORD rule; meaningful statements in order/inventory/pricing services ≥ 80% line coverage (measured, not asserted).
- **NFR-12 (Deployability):** `docker compose up` on a clean machine starts API + DB, applies migrations automatically, seeds demo data (flag-controlled), and passes a health check within 60 s.
- **NFR-13 (Auditability):** Every state-changing business action is reconstructible from `audit_logs` + snapshot rows without referring to external systems.
- **NFR-14 (Recoverability):** A documented `pg_dump`/restore procedure exists; compose file mounts a named volume for DB data so container recreation does not lose data.

## 10. Measurable Success Criteria

Success is judged against `acceptance-criteria.md`. Summary (all values are **targets to be measured in Phase 3**, not claims):

1. **SC-01:** 100% of Must-Have acceptance criteria (AC-xxx) pass in the automated suite.
2. **SC-02:** 20 concurrent customers attempting to buy the last 5 units of a product produce exactly 5 successful reservations and 15 clean `409` rejections — zero oversold units (measured by concurrency integration test).
3. **SC-03:** Duplicate order submissions with the same idempotency key create exactly one order in 100/100 scripted attempts.
4. **SC-04:** Price/name edits after ordering do not change any historical order or invoice totals in 100% of regression tests.
5. **SC-05:** End-to-end happy path (login → cart → order → confirm → fulfill → invoice download) completes in Playwright with all assertions green.
6. **SC-06:** A vertical can place a real-seeming pilot order flow in ≤ 10 minutes of training (qualitative check with pilot users, recorded with date and participants when performed).
7. **SC-07:** Performance targets in NFR-05 met in the defined load test; failures reported with measured numbers.

## 11. Dependencies

- Docker Desktop with WSL2 backend (verified working on dev machine per prior environment audit).
- Node.js ≥ 20 LTS, npm.
- PostgreSQL 16 (containerized via compose).
- Libraries: `express`, `pg`, `node-pg-migrate`, `jsonwebtoken`, `bcryptjs`, `zod`, `helmet`, `cors`, `dotenv`; dev/test: `supertest`, `vitest`, `@testing-library/react`, `playwright`, `eslint`.

## 12. Open Questions (tracked for Phase 2)

- OQ-01: Should `agent` be able to create orders on behalf of a customer? (Assumed **no** for v1.)
- OQ-02: Tax handling — per-product rate applied to line subtotal (assumed) vs. order-level blended rate.
- OQ-03: Retention period for idempotency keys (assumed 24 h; see `decision-log.md` D-08).
