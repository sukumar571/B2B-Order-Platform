# Viva / Interview Questions — B2B Order Management Platform

Project-specific questions an evaluator or interviewer is likely to ask, with accurate answers
drawn from **this** codebase and its evidence. Answers never claim un-measured results — items
that were *not* tested (load timing, pilot usability, business impact) are stated as such.
Cross-references: [`requirements-traceability.md`](requirements-traceability.md),
[`security-review.md`](security-review.md), [`limitations.md`](limitations.md),
[`test-results.md`](test-results.md), [`decision-log.md`](decision-log.md).

---

## 1. Problem, scope & stakeholders

**Q. What business problem does this solve?**
A. A B2B distributor was taking orders over email and spreadsheets: stock was a lagging manual
count, prices were recomputed by hand, and there was no single record of who changed what. This
platform lets customers order against **live, reserved stock**, the **server** computes every
price, fulfilment **auto-mints an invoice**, and **every state change is appended to an audit
log** — for a single distributor tenant (C-10).

**Q. Who are the users and what differs between them?**
A. Three roles enforced server-side (`middleware/authorize.js`):
**ADMIN** — manages the catalog, inventory ledger, users, and reads audit/dashboard;
**ORDER_MANAGER (agent)** — confirms and fulfils orders, which generates the invoice;
**CUSTOMER** — browses, carts, places orders, and views *only their own* orders/invoices.
Disabled accounts cannot log in at all.

**Q. What is explicitly out of scope?**
A. Payments/settlement, shipping & carrier tracking, multi-warehouse/batch inventory, per-customer
pricing, discounts, credit limits, multi-jurisdiction tax, procurement, multi-tenancy, and report
export — all listed in `requirements.md` §3.2 and `limitations.md` §1.

---

## 2. Architecture

**Q. Describe the stack and why it's shaped this way.**
A. A monorepo: a **Vite + React 18 SPA** (`frontend/`, plain JS) talking to a **layered Express
API** (`backend/`: routes → middleware → controllers → services → repositories → PostgreSQL),
with **node-pg-migrate** migrations and a Playwright **e2e/** suite. Frontend and backend are
served **same-origin** through nginx (`/api` reverse proxy) so the auth cookie and CORS story
stay simple. Chosen to satisfy constraints C-01..C-08 (React/Express/PostgreSQL/Zod/JWT+bcrypt).

**Q. Walk me through one request end-to-end.**
A. Browser → nginx → Express route → `authenticate` (verifies HS512 access JWT, reloads the user
row fresh per request) → `authorize(role…)` → controller validates the body with a **Zod** schema
→ service owns the transaction/business rules → repository runs **parameterized** `pg` SQL →
result mapped and returned; a state change writes an `audit_logs` row in the same transaction.
Errors funnel to a central error handler returning `{ error: { code, message } }`.

**Q. Why a repository layer instead of querying in controllers?**
A. It isolates SQL from HTTP concerns, keeps transactions in one place (services), and makes the
data access independently testable. It also enforces that **all** SQL is parameterized (C-04) —
no string concatenation of user input.

---

## 3. Data model & integrity

**Q. How do you prevent overselling stock?**
A. Two guards, one application and one database. On order create/confirm the service issues
`SELECT … FOR UPDATE` on the inventory row, so concurrent buyers serialise on the same row; then
every write must satisfy the DB constraint `CHECK (physical_stock - reserved_stock >= 0)`. A
**20-way concurrency integration test** proves 20 simultaneous orders of a limited SKU never drive
stock negative (SC-02). It returns `409 INSUFFICIENT_STOCK` and leaves stock unchanged when the
quantity exceeds availability.

**Q. How is money stored and computed?**
A. Never as a float. Prices/totals are `NUMERIC` in Postgres and handled through `utils/money.js`
using integer cents / decimal-safe arithmetic, so subtotal, tax, and grand total add exactly
(`19.99 × 3 @ 7.5%` → subtotal `59.97`, tax `4.50`, grand `64.47` is a hand-checked assertion).
Invoice totals are required to equal the order total.

**Q. What key tables exist and how are they related?**
A. Users, products, inventory + `inventory_movements` (ledger), carts/cart items, orders/order
items, invoices/invoice items, refresh-token families, and append-only `audit_logs`. Order/invoice
line items **snapshot** product name and price at purchase time, so later catalog edits don't
rewrite history. The ER diagram is in `database-design.md`.

**Q. How do you guarantee an order can't skip lifecycle steps?**
A. A state machine in `order.service.js`: `pending → confirmed → fulfilled` (and a rejected path).
Attempting an out-of-order transition (e.g. fulfil a `pending` order) throws
`409 INVALID_STATE_TRANSITION`. Fulfilment runs *inside* the same transaction that inserts the
invoice, so an order can never be fulfilled without exactly one invoice.

---

## 4. Security

**Q. How does authentication work and why this design?**
A. Short-lived (15-min) HS512 **access JWT kept in SPA memory only — never localStorage**, plus a
**rotating refresh token as an HttpOnly / SameSite=Strict / Secure cookie**. The DB stores only a
SHA-256 **hash** of the refresh token; on use it rotates, and reuse of an old token revokes the
whole family (theft detection). The user is reloaded from the DB every request so deactivation is
honoured even with a valid token. Rationale in D-19.

**Q. How are passwords and SQL handled?**
A. `bcryptjs` cost 12 for hashing; the password never leaves the server. All queries are
parameterized (C-04) and inputs validated with Zod, so there is no concatenation path for
injection.

**Q. How is authorization enforced?**
A. Per-endpoint `authorize(...)` middleware checks the role claim; ownership checks use
`requireSelf`/`requireOwnership` so a customer fetching another customer's order gets **404**
(no existence leak), not a 403. There is no public `POST /api/users` — users are admin-created.

**Q. What secrets hygiene did you apply?**
A. Secrets are **env-only** (C-06), never baked into images (image audit shows `.env count: 0`),
and Compose fails fast with `${VAR:?}` if `POSTGRES_PASSWORD`/`JWT_*` are missing or a weak JWT
secret / `COOKIE_SECURE=false` is set. A live fail-closed capture is in the Phase 13 evidence.

**Q. What security work is still open?**
A. Honestly listed in `security-review.md` §8/§9: no in-container TLS (external proxy), no
penetration test or load test, in-memory access tokens have no server-side blocklist, and rate
limiting is per-process until moved to Redis.

---

## 5. Deployment & operations

**Q. How is it deployed and what makes it reproducible?**
A. `docker compose up` with a production-shaped `docker-compose.yml` plus a `docker-compose.dev.yml`
override. Multi-stage builds on `node:20-alpine` / `nginx:1.27-alpine` / `postgres:16-alpine`;
app containers run as the non-root `node` user (uid 1000). In production PostgreSQL is **not**
host-published; services talk over the Compose network by service name; nginx proxies `/api` for a
same-origin SPA.

**Q. How do migrations run without racing?**
A. A **one-shot `migrate` service** (`restart: 'no'`) starts only after the DB reports healthy, and
the backend waits on `service_completed_successfully` before it boots — so migrations run exactly
once per deploy, not on every app start (D-29, which superseded the earlier migrate-on-boot D-03).

**Q. How do you know data survives a restart?**
A. Postgres uses a named `pgdata` volume. A Phase 13 test tore down and recreated the app services
and re-queried identical row counts after restart. Backups via `pg_dump` are documented and proven,
but scheduling them is left to the operator. **Volumes are never auto-deleted** by scripts.

---

## 6. Testing & evidence

**Q. What did you actually run, and what were the real numbers?**
A. **352 automated checks, 0 failures**: backend **228/228** (39 suites, unit + integration incl.
the 20-way concurrency test), frontend **74/74** (Vitest + React Testing Library), browser E2E
**17/17** (10 happy-path journeys + 7 negative cases) on Chromium. Post-deploy smoke on the Docker
stack was **9/9**. All figures come from `test-results.md`, which records only tests that ran.

**Q. What is your coverage and is it enforced?**
A. Measured and disclosed, not hard-gated: backend ~**96.34%** lines, frontend ~**87.76%** lines.
Two frontend screens (LoginPage 5.63%, UsersPage 6.01%) are intentionally low because real browser
journeys cover them — this gap is stated in `limitations.md` §4, not hidden.

**Q. Did you measure performance or user impact?**
A. **No, and I won't claim it.** The 20-way test proves *correctness* of the oversell guard, not
p95 latency; SC-06 (≤10-min pilot) and SC-07/NFR-05 (load timing) were never run, and no business
impact was measured because there were no real pilot users. Load benchmarking is roadmap item #6.

---

## 7. Trade-offs & decisions (from the decision log)

**Q. Name a hard trade-off you made.**
A. **D-19**: keeping access tokens in memory instead of localStorage avoids XSS token theft but
causes a cold-reload rehydration race (K-3): a deep-link `page.goto` can briefly bounce to
`/login` before the refresh cookie re-establishes the session. E2E navigates by clicking to avoid
it; it's a known, documented limitation.

**Q. Any dependency compromises?**
A. Yes. **D-17**: dev PostgreSQL is on host port **5433** because a native Postgres holds 5432, and
`node-pg-migrate` is pinned to **v7** (CommonJS). That pin transitively carries **2 high `glob`
advisories (D-27)** that are unreachable given how migrations are actually invoked — accepted with
a re-review trigger, not silently ignored. A real **bcryptjs packaging defect** (it was in
devDependencies but needed at runtime) was found and fixed during the Phase 13 image audit.

---

## 8. "If you had more time…"

A. First the safety-of-scale items that retire the un-measured claims: external TLS, Redis-backed
rate limiting and token revocation, a managed secrets store, a CI pipeline (lint/test/audit/
gitleaks/build), and a real k6 load benchmark to replace "not measured." Then business features by
demand: payments, per-customer pricing, multi-warehouse stock, and eventually multi-tenancy. The
full prioritised list with effort sizing is in `future-roadmap.md`.
