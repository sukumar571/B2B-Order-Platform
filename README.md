# B2B Order Management Platform

A web platform where **distributors** manage product catalog and stock and their **B2B
customers** place validated orders against real-time inventory, with every change audited
and invoiced automatically. It replaces email-and-spreadsheet order handling.

> **Current status — Phase 15: Final acceptance audit & release. ✅ Phases 1–15 delivered.**
> An independent senior-reviewer pass re-ran every gate on this working tree (no prior result
> assumed): frontend build, clean isolated DB migrations (18) + seed idempotency, backend
> **228/228** (96.34% lines), frontend **74/74** (87.76%), browser E2E **17/17**, Docker Compose
> ordered startup + persistence (**9/9** deploy smoke), README command cross-check, and a
> secrets/generated-file audit (`git add -A --dry-run` → 336 files, **zero** secrets/dumps).
> **No critical or high defect found**; one medium release-hygiene fix applied (package versions
> `0.1.0 → 1.0.0`). Acceptance criteria for a **v1.0.0** functional release are met, scoped to the
> single-tenant v1. Pilot usability remains honestly **not measured**; performance-under-load was
> subsequently **measured** (see below) and passed the NFR-05 targets on dev hardware.
> Full findings: [`docs/acceptance-report.md`](docs/acceptance-report.md).
>
> **Post-release — performance benchmark (NFR-05 / NFR-PERF-01 / SC-07).** A dependency-free
> 20-virtual-user load harness (`backend/scripts/load/`, `npm run perf`) benchmarks the real app
> against an isolated `b2b_oms_perf` DB at 500 products / 200 customers / 1,000+ orders.
> Measured **PASS**: reads p95 **118 ms** (≤ 500), order creation p95 **501 ms** (≤ 1500), 5xx **0%**
> — on a 4-core i3 dev laptop with Docker PostgreSQL (a dev datapoint, not production capacity).
> Evidence: [`evidence/test-reports/perf-load.md`](evidence/test-reports/perf-load.md).
>
> **Prior — Phase 14: Final documentation & presentation.**
> Phase 14 added no application code. It verified the build against
> [`docs/requirements.md`](docs/requirements.md) and
> [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) and consolidated the evaluation
> record: [`docs/requirements-traceability.md`](docs/requirements-traceability.md) (every FR/NFR →
> module → AC → evidence), [`docs/security-review.md`](docs/security-review.md),
> [`docs/limitations.md`](docs/limitations.md), [`docs/future-roadmap.md`](docs/future-roadmap.md),
> [`docs/demo-script.md`](docs/demo-script.md), [`docs/viva-questions.md`](docs/viva-questions.md)
> and [`docs/presentation-outline.md`](docs/presentation-outline.md). All figures cite tests that
> **actually ran** — **352 automated checks (228 backend + 74 frontend + 17 browser E2E), 0
> failures**, plus a **9/9** post-deploy smoke — and the genuinely captured screenshots in
> [`evidence/screenshots/`](evidence/screenshots/). Performance-under-load, pilot-usability timing,
> and business impact were **not measured** and are **not claimed** anywhere.
>
> **Prior — Phase 13: Docker & reproducible deployment.**
> Phase 13 containerized the completed application **without changing application behavior**.
> A production-shaped `docker-compose.yml` (plus a `docker-compose.dev.yml` host-port override)
> runs four services — `db`, a **one-shot `migrate`**, `backend`, `frontend` — from hardened
> multi-stage images (`node:20-alpine`, `nginx:1.27-alpine`, `postgres:16-alpine`) that install
> with `npm ci --omit=dev` from committed lockfiles, run the API **non-root** (`uid 1000`), and
> ship **no `.env` and no hardcoded secrets**: required values are interpolated fail-fast
> (`${VAR:?…}`) from a git-ignored root `.env`, and the backend still refuses to boot in
> `production` on a weak JWT secret or `COOKIE_SECURE=false`. PostgreSQL is **not published** in
> the base file and is reached only by the `db` service name; the SPA reaches the API over the
> **same browser origin** through nginx's `/api` proxy (no CORS). Migrations run as a **single
> controlled step** gated on `db` health and `service_completed_successfully` — proven to start
> exactly one migration container even under `--scale backend=3` — and the `pgdata` volume
> **survives a full `down`/restart**. Verified at runtime (Docker was available): clean build →
> readiness ordering → **18 migrations / 14 tables applied** → idempotent migrate → seed →
> persistence across a stop → `pg_dump`/`pg_restore` round-trip → a **9/9** deploy smoke through
> the browser origin, all in an isolated Compose project that left the development database
> untouched. This surfaced and fixed one real defect: **`bcryptjs` was misdeclared as a
> devDependency**, so the production image (`--omit=dev`) crashed at auth — promoted to
> `dependencies`. Plan: [`docs/deployment.md`](docs/deployment.md); evidence in
> [`evidence/test-reports/phase13-docker-deployment.md`](evidence/test-reports/phase13-docker-deployment.md).
>
> **Prior — Phase 12: QA & test automation.**
> Phase 12 added the one missing test tier — **browser end-to-end automation** — and a
> reproducible **coverage** path, with **no change to application code, schema, migration or
> dependency version**. A new `e2e/` Playwright workspace runs the **ten critical business
> journeys** (admin creates a product → updates stock → customer registers → adds to cart →
> places an order → reservation verified → order manager ships → customer views the invoice →
> admin views audit + dashboard → a customer is denied another customer's order) plus **seven
> negative/adversarial paths** (insufficient stock, invalid quantities, inactive products,
> atomic DB rollback, idempotent duplicates, unauthorized actions, disabled account) — all
> against a **disposable, name-guarded `b2b_oms_e2e` database** that no test can reset unless
> its name ends in `_e2e`. **17/17 E2E pass, 228/228 backend (96.34% line coverage), 74/74
> frontend (87.76%), integration 133/133, ESLint 0 errors, Prettier clean.** Coverage is
> measured but **never gated** by an arbitrary threshold. Plan and results:
> [`docs/test-plan.md`](docs/test-plan.md) · [`docs/test-results.md`](docs/test-results.md);
> evidence in [`evidence/test-reports/phase12-e2e-and-test-automation.md`](evidence/test-reports/phase12-e2e-and-test-automation.md).
>
> **Prior — Phase 11: Security & dependency audit.**
> Phase 11 changed **no application code, schema or dependency version**. It ran `npm audit`
> across the root, backend and frontend workspaces, triaged every finding by **reachability**
> rather than raw severity, and recorded the accepted/deferred risk as decision **D-27**: the
> shipped browser bundle audits **0 vulnerabilities** under `--omit=dev` (the flagged Vitest /
> `tinypool` items are test-only devDependencies), the root workspace is clean, and the backend's
> 2 high findings sit in `glob`'s CLI `-c/--cmd` path that the app never invokes and that a fix
> would force the D-17-conflicting ESM upgrade of `node-pg-migrate`. All quality gates were then
> re-run green against the current tree — **95/95 backend unit, 133/133 integration, 74/74
> frontend, ESLint 0 errors, clean build, Prettier clean** — proving Phases 1–10 are unregressed.
> Evidence: [`evidence/test-reports/phase11-security-dependency-audit.md`](evidence/test-reports/phase11-security-dependency-audit.md).
>
> **Prior — Phase 10: Complete frontend integration.**
> Every backend module built in Phases 3–9 (auth, catalog, inventory, cart, orders, invoices,
> audit, dashboards and admin users) is now wired to a single, consistent, responsive React
> interface with **no mock data** — each screen reads live server state and displays
> **server-calculated** money. This phase closed the two remaining gaps: a public
> **customer registration** flow (`/register`, POST `/api/auth/register` — the backend forces the
> CUSTOMER role, so the client can never mint a privileged account) and **authentication-expiry
> handling**: the API client now transparently refreshes the in-memory access token once on a
> `401 UNAUTHENTICATED` and replays the request, and the SPA silently rehydrates a session from
> the HttpOnly refresh cookie on load — so a page refresh no longer logs the user out. Role-aware
> navigation is a **UX convenience only**; the backend remains the sole authorization authority.
> No demo credentials, secrets or production data are hardcoded in the shipped UI (the previous
> seed-account hint was removed from the login screen; dev seeds live only in `database/seeds/`
> and this README). The whole interface passes **74/74 Vitest + React Testing Library tests**,
> ESLint (0 errors), Prettier and a clean production build. Prior **Phase 9** audit/dashboard
> behaviour is unchanged: every auditable business change writes its `audit_logs` row inside the
> same transaction. Design docs in [`docs/`](docs/) are updated as-built (API spec v1.6;
> decision D-19 auth token model).

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite (JavaScript, HTML, CSS) |
| Backend | Node.js + Express (JavaScript, **CommonJS**) |
| Database | PostgreSQL 16 — schema live via `node-pg-migrate` v7 (13 tables / 18 migrations, Phases 3–7) |
| Auth | **Live:** JWT (`jsonwebtoken`) + `bcryptjs` + refresh-token rotation; backend-enforced RBAC |
| Validation | Zod — strict schemas on auth, catalog/inventory, cart **and order** payloads + query/path params (Phases 4–7) |
| Testing | Node test runner + Supertest (backend) · Vitest + React Testing Library (frontend) |
| Deployment | Docker + Docker Compose (multi-stage, non-root, one-shot migration service) |

## Repository layout

```
frontend/            React + Vite SPA — src/{pages,components,hooks,context,services,utils}
  src/pages/         Landing, ProductsPage, ProductDetailPage, LoginPage, RegisterPage, CartPage,
                     OrderHistoryPage, OrderDetailPage, OrderConfirmationPage, OrderProcessingPage,
                     InvoiceListPage, InvoicePage, AdminProductsPage, InventoryPage, DashboardPage,
                     AuditLogsPage, UsersPage
backend/             Express API — src/{config,routes,controllers,services,repositories,middleware,utils,db,constants}
  migrations/        18 versioned, reversible node-pg-migrate scripts
  scripts/db/        safe create / migrate / seed / health-check / integration-test runner
  scripts/smoke/     live smoke scripts (phase5-catalog-smoke.js)
  tests/             Node + Supertest HTTP tests (app, auth, catalog, cart, order) + PostgreSQL integration
database/seeds/      development seed data (users incl. admin/agent/disabled + products)
docs/                planning & design documents (as-built updated)
evidence/            screenshots/ (browser) and test-reports/ (real lint/build/test output)
docker-compose.yml   db + one-shot migrate + backend + frontend (production-shaped; only the web port is published)
docker-compose.dev.yml  local override that publishes PostgreSQL :5433 and the API :4000 for host-side tooling
package.json         root orchestration scripts
```

## Prerequisites

- **Node.js ≥ 20** (developed/tested on v24) and npm ≥ 10.
- **Docker Desktop** (with WSL2 backend on Windows) — used to run PostgreSQL 16.
  Any other PostgreSQL 16+ works too by pointing `DATABASE_URL` at it.
- HTTP/unit tests need **no** database; only `npm run test:integration` does (it
  targets the isolated `DATABASE_URL_TEST` database and skips otherwise).

## Quick start (local development)

```bash
# 1) Install all dependencies (root + backend + frontend)
npm run install:all

# 2) Configure environments (real .env files are git-ignored; never commit secrets)
cp backend/.env.example  backend/.env
cp frontend/.env.example frontend/.env
#    .env.example ships safe local defaults matching docker-compose (dev-only).

# 3) Start PostgreSQL (host-published dev port) and initialize the database (safe, non-destructive)
npm run db:up            # = docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
npm run db:create        # CREATE DATABASE only if missing — never drops
npm run db:migrate       # apply the 18 versioned migrations
npm run db:seed          # optional demo data; skips itself if data exists
npm run db:health        # read-only connectivity + schema check

# 4) Run both dev servers (two terminals)
npm run dev:backend     # Express API on http://localhost:4000  (GET /api/health)
npm run dev:frontend    # Vite SPA on  http://localhost:5173  (proxies /api -> backend)
```

Open **http://localhost:5173**. The landing page calls `GET /api/health` and shows a
**loading → connected** state (or a **failure** state with a **Retry** button if the API
is not running). `/products` browses the live catalog, `/login` signs in (dev seed creds
below), and `/admin/products` + `/inventory` are role-guarded staff screens.

## Scripts

| Command | What it does |
|---|---|
| `npm run install:all` | Install root, backend, and frontend dependencies |
| `npm run dev:backend` / `npm run dev:frontend` | Start each dev server |
| `npm run build:frontend` | Production build of the SPA (`frontend/dist/`) |
| `npm test` | Run backend **and** frontend tests (DB integration tests auto-skip) |
| `npm run test:backend` / `npm run test:frontend` | Run one suite |
| `npm run test:integration` | PostgreSQL suite against the isolated `DATABASE_URL_TEST` DB (migrates first) |
| `npm run test:e2e` | Playwright browser E2E — boots API + SPA, recreates the **disposable `b2b_oms_e2e`** DB, runs the 10 journeys + 7 negative paths |
| `npm run e2e:bootstrap` | Recreate the disposable E2E DB only (name-guarded; refuses non-`*_e2e`) |
| `npm run test:all` | `test` + `test:integration` + `test:e2e` |
| `npm run coverage:backend` / `coverage:frontend` / `coverage` | V8 coverage of the full backend suite (isolated test DB) / Vitest frontend coverage (measured, **no threshold**) |
| `npm run perf:seed` | Build/refresh the isolated `b2b_oms_perf` benchmark dataset (500 products / 200 customers / 1,000 orders); never touches dev/test DBs |
| `npm run perf:load` / `npm run perf` | 20-virtual-user load benchmark (NFR-05 p95 targets); writes `evidence/test-reports/perf-load.{md,json}` |
| `npm run db:create` / `db:migrate` / `db:seed` / `db:health` | Safe database setup commands (backend equivalents: `npm --prefix backend run db:create:test`, `db:migrate:test`, `db:health:test`) |
| `npm run db:migrate:down` | Roll back the **last** migration (add `-- --all` via backend script `db:migrate:down` args to revert everything) |
| `npm run db:up` | Start only PostgreSQL **with host-published ports** (dev override) for host-side tooling |
| `npm run docker:build` / `docker:up` / `docker:down` / `docker:ps` / `docker:logs` | Build images / start the stack / stop it (data kept) / service+health status / follow logs |
| `npm run docker:up:dev` | Whole stack **plus** the dev override that publishes PostgreSQL `:5433` and the API `:4000` |
| `npm run docker:migrate` | Run the controlled one-shot migration step (`docker compose run --rm migrate`) |
| `npm run docker:seed` | Optional demo data via the `tools` profile (skips itself if data exists) |
| `npm run docker:smoke` | Read-only post-deploy verification through the public browser origin (`http://localhost:8080`) |
| `npm run lint` | ESLint across backend and frontend |
| `npm run format` / `npm run format:check` | Prettier write / check |

Run individually inside a package with npm prefixes, e.g.
`npm --prefix backend run test:coverage`.

## Docker

The deployment is split into a **production-shaped base file** and a **local override**:

| File | Publishes to host | Use |
|---|---|---|
| `docker-compose.yml` | **only** the web port (`${WEB_PORT:-8080}:80`) | the reference topology — PostgreSQL & API are internal-only |
| `docker-compose.dev.yml` | adds PostgreSQL `:5433` and API `:4000` | host-side scripts, the Vite dev server, the test suites. **Never for production.** |

```bash
cp .env.example .env       # set real POSTGRES_PASSWORD + ≥32-char JWT_ACCESS/REFRESH secrets
npm run docker:up          # build images and start db -> migrate -> backend -> frontend
npm run docker:ps          # service + health status
npm run docker:smoke       # verify through http://localhost:8080
npm run docker:down        # stop & remove containers — the pgdata volume (data) is KEPT
```

**How it works:**

- **Services.** `db` (`postgres:16-alpine`, data in the named `pgdata` volume), a **one-shot
  `migrate`**, `backend` (Express, runs as `node`/uid 1000), and `frontend`
  (`nginx:1.27-alpine` serving the Vite build). Containers talk over the Compose network by
  **service name** — the API reaches PostgreSQL at `db:5432`, and nginx proxies `/api` to
  `backend:4000` — so the SPA is **same-origin** and needs no permissive CORS.
- **Readiness & startup ordering.** `db` and `backend` have `HEALTHCHECK`s; `migrate` waits
  for `db: service_healthy`, and `backend` waits for `migrate: service_completed_successfully`.
- **Migrations are a controlled single step, not per-replica boot work.** The API's `CMD` only
  starts the server. Scaling the API cannot start more than one migration container
  (verified with `--scale backend=3` → exactly one `migrate`). Run it explicitly with
  `npm run docker:migrate` (idempotent — "No migrations to run!" on a current schema).
- **Secrets are never baked in.** No Dockerfile copies `.env*`, both `.dockerignore` files
  exclude them, and required deployment values come from the **git-ignored root `.env`** via
  `${VAR:?…}`, so Compose **fails fast** if `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET` or
  `JWT_REFRESH_SECRET` is missing. The backend then refuses to boot in `production` on a weak
  secret or `COOKIE_SECURE=false`. Nothing sensitive is hardcoded.
- **Data survives restarts.** `down`/`stop`/`restart` and image rebuilds keep the volume; only
  `down -v` destroys it — **documented as a destructive, human-confirmed action** and never run
  automatically. Backup/restore (`pg_dump -Fc` / `pg_restore`) and full start/stop/logs
  instructions live in [`docs/deployment.md`](docs/deployment.md).

> **HTTPS:** these containers serve plain HTTP; put the SPA behind TLS in a real deployment
> (a load balancer or host reverse proxy) and keep `COOKIE_SECURE=true`. `X-Forwarded-Proto`
> is already forwarded. `localhost` works for the local demo because browsers treat it as a
> trustworthy origin and still send `Secure` cookies there — this does not extend to any other host.

> **Host port note (D-17):** the dev override maps PostgreSQL to host **5433** because this
> machine runs an unrelated native PostgreSQL on 5432. Inside the network it is always `db:5432`.

> **Graceful shutdown verification:** start `npm run dev:backend`, then press **Ctrl+C**.
> You should see `server.shutdown.initiated` then `server.shutdown.complete` log lines
> (SIGINT/SIGTERM are handled in `backend/src/server.js`).

## Environment variables

| Var | Location | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | backend | `development` | `test` disables request logging |
| `PORT` | backend | `4000` | API listen port |
| `CORS_ORIGINS` | backend | *(empty)* | Comma-separated allow-list; empty = same-origin only (never `*`) |
| `JSON_BODY_LIMIT` | backend | `100kb` | Max request body size |
| `SHUTDOWN_TIMEOUT_MS` | backend | `10000` | Graceful-shutdown hard timeout |
| `DATABASE_URL` | backend | `postgres://b2b:change-me-dev-only@localhost:5433/b2b_oms` | Development database connection string |
| `DATABASE_URL_TEST` | backend | `postgres://b2b:change-me-dev-only@localhost:5433/b2b_oms_test` | **Isolated** database used only by the integration suite |
| `DB_POOL_MAX` | backend | `10` | `pg` connection-pool size |
| `DB_CONNECTION_TIMEOUT_MS` | backend | `5000` | Per-connection acquire timeout |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | backend | *(empty → dev fallback)* | **Env-only signing keys.** Production boot **refuses to start** if missing, < 32 chars, or the dev default |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | backend | `15m` / `7d` | Short-lived access token / rotating refresh token |
| `JWT_ISSUER` / `JWT_AUDIENCE` | backend | `b2b-oms` / `b2b-oms-api` | Verified on every token (`iss`/`aud` claims) |
| `BCRYPT_ROUNDS` | backend | `12` | bcryptjs cost factor (C-02 mandates bcryptjs) |
| `COOKIE_SECURE` | backend | `false` | `Secure` flag on auth cookies; **must be `true` in production** (enforced at boot) |
| `AUTH_RATE_MAX` / `REGISTER_RATE_MAX` / `AUTH_RATE_WINDOW_MS` | backend | `10` / `5` / `900000` | Per-IP rate limits on login+refresh / register |
| `VITE_API_BASE_URL` | frontend | *(empty)* | Absolute API origin; empty uses same-origin `/api` (via proxy) |
| `VITE_BACKEND_ORIGIN` | frontend | `http://localhost:4000` | Where the Vite dev proxy forwards `/api` |

`DATABASE_URL` / `DATABASE_URL_TEST` and the `JWT_*` / `BCRYPT_ROUNDS` / `COOKIE_SECURE`
vars are live (Phase 3/4) with dev-only defaults — change every secret anywhere but on
your local machine.

**Compose / deployment variables** live in the **root `.env`** (template:
[`.env.example`](.env.example)) and are separate from the per-package files above: the
**required** secrets `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (no
default — Compose fails fast), plus non-secret knobs `POSTGRES_USER` / `POSTGRES_DB` /
`COOKIE_SECURE` / `CORS_ORIGINS` / `WEB_PORT` / `B2B_IMAGE_TAG` and the **dev-only**
`POSTGRES_HOST_PORT` (5433) and `API_HOST_PORT` (4000) published by
`docker-compose.dev.yml`. See [`docs/deployment.md`](docs/deployment.md) §3.

## Database (Phases 3–5)

The schema is versioned with **node-pg-migrate** (pinned v7 — CommonJS) in
`backend/migrations/` (14 reversible migrations, 13 tables) and queried with **pg**
parameterized SQL through the pooled singleton in `backend/src/db/pool.js`.

### Migration, seed, and rollback commands

```bash
npm run db:create          # CREATE DATABASE b2b_oms only if missing — never drops anything
npm run db:migrate         # apply all pending migrations (up)
npm run db:seed            # development data (3 users, 6 products + inventory); SKIPS itself
                           # if any users/products already exist — never overwrites
npm run db:health          # read-only check: connectivity, server version, 13/13 tables,
                           # applied-migration count (never mutates)

npm run db:migrate:down    # roll back the LAST migration (safe, stepwise)
# roll everything back (only do this on a throwaway database):
npm --prefix backend run db:migrate:down -- --all

# The same commands target the isolated test DB with a `:test` suffix (backend scripts):
npm --prefix backend run db:create:test
npm --prefix backend run db:migrate:test
npm --prefix backend run db:health:test
npm --prefix backend run db:migrate:down:test
```

Safety contract: no script ever issues `DROP DATABASE`, `DROP SCHEMA`, or `TRUNCATE`.
The only destructive-adjacent operation is `down --all`, which drops **tables the
migrations created** — designed for the isolated test database, where the integration
suite uses it to prove reversibility.

### Stock model (defined in the schema itself)

| Column | Meaning | Rules |
|---|---|---|
| `physical_quantity` | Units physically on hand | `>= 0`; changed only by receipts/corrections |
| `reserved_quantity` | Units committed to open orders | `>= 0`; order creation increments, cancel/fulfillment decrements |
| `available_quantity` | Sellable stock = physical − reserved | `GENERATED ALWAYS … STORED` — read-only (writes raise SQLSTATE 428C9); `CHECK (physical − reserved >= 0)` is the hard oversell guard |
| `low_stock_threshold` | Per-product replenishment floor (Phase 5) | `integer NOT NULL DEFAULT 20 CHECK (>= 0)`; a product is **low-stock** iff `available_quantity <= low_stock_threshold` (drives `GET /api/inventory/low-stock`) |

### Integration tests (isolated database)

`npm run test:integration` creates nothing implicitly — it requires `DATABASE_URL_TEST`
pointing at a **separate** database (`b2b_oms_test`), runs migrations against it, then runs
**51 tests** across three files: 20 schema tests (connectivity, FK enforcement, uniqueness,
quantity CHECKs, money bounds, totals invariants, snapshots, audit rollback, append-only
audit, idempotency, oversell, reversibility) + 16 authentication tests (register/login/
refresh/logout/me, RBAC, rate limiting) + **15 catalog/inventory HTTP tests** (product CRUD,
duplicate-SKU 409, soft archive, pagination/search/sort fail-closed, role authorization,
transactional stock adjustment). Guard rails: the suite only executes when
`B2B_RUN_DB_TESTS=1` (set by the runner) **and** `DATABASE_URL_TEST` is configured — plain
`npm test` auto-skips it and needs no database at all. Because the files share the one
test database and the schema suite includes a destructive `down --all` reversibility test,
the runner passes `--test-concurrency=1` so the files execute **serially** (otherwise
Node's default parallel file execution races the table drop and yields spurious 500s /
cancelled tests). Setup:

```bash
npm --prefix backend run db:create:test   # CREATE DATABASE b2b_oms_test if missing
npm run test:integration                  # migrate + run the DB suites (schema + auth)
```

## Security model (Phase 4)

**Token design (decision D-19 — two-token, hybrid):**

| Token | Form | Where it lives | Lifetime |
|---|---|---|---|
| Access | HS256 JWT (`sub/role/typ/iss/aud`) | JSON response → **memory only** in the SPA; sent as `Authorization: Bearer` | 15 min (`JWT_ACCESS_TTL`) |
| Refresh | Opaque 256-bit secret in a JWT envelope | `HttpOnly; SameSite=Strict; Path=/api/auth` cookie; DB stores **only its SHA-256 hash** | 7 days (`JWT_REFRESH_TTL`), rotated on every use |

- **Bearer storage & XSS:** the access token is deliberately kept in memory —
  never `localStorage`/`sessionStorage` — so an XSS payload cannot read it from
  persistent storage, and the refresh cookie is unreadable to JavaScript
  (`HttpOnly`). A leaked access token self-heals within 15 minutes.
- **CSRF:** the only cookie-bearing endpoint (`POST /api/auth/refresh`) requires
  `SameSite=Strict` posting, which blocks cross-site submission outright — no
  separate CSRF token is needed for this design. All other endpoints are
  header-driven (browsers don't attach `Authorization` cross-site).
- **Rotation + reuse detection:** refreshing revokes the presented token and
  issues a successor in the same *family*. If a spent token is presented again
  (stolen-copy replay), the **entire family is revoked** and the caller gets
  `401 TOKEN_REUSED`.

**Guarantees enforced beyond tokens:**

- Passwords: `bcryptjs` cost 12 (`BCRYPT_ROUNDS`); only `password_hash` exists in
  the schema; responses/loggers never carry hashes or secrets (logger redacts
  `password|token|secret|authorization|cookie|email…` keys).
- Input validation: Zod **strict** schemas — an unknown field such as `role` is a
  hard `400`. Registration can only create `customer`; `admin`/`agent`
  (ORDER_MANAGER) come exclusively from the controlled dev seed or a future admin
  process.
- Token validation on every request: signature, **pinned HS256** (`alg:none` and
  algorithm-confusion rejected), expiry, `iss`, `aud`, and `typ` (a refresh token
  can never be used as a bearer token); `authenticate` then re-loads the user,
  so **disabled or deleted accounts lose access immediately**
  (`403 ACCOUNT_DISABLED` at login, `401` on API calls).
- Login errors are identical for unknown email vs wrong password
  (`401 INVALID_CREDENTIALS`, plus constant-work bcrypt compare) — no user
  enumeration. Duplicate registration email → `409 EMAIL_TAKEN`.
- RBAC: reusable `authorize('ADMIN', …)` middleware; cross-user data access is
  blocked by `requireSelf` (identity from the token only) and
  `requireOwnership` (stranger → `403`, missing resource → `404` so existence
  isn't leaked; admin bypass is opt-in per route).
- Rate limiting on sensitive endpoints (per client IP): login/refresh
  `10`/15 min, register `5`/15 min → `429 RATE_LIMITED` with `RateLimit-*` +
  `Retry-After` headers. Tunable via env; the in-memory store is per-instance
  (swap for a Redis store if the API ever scales horizontally).
- Secrets come from the environment **only**; in `production` the server refuses
  to boot with missing/short/dev-default JWT secrets or `COOKIE_SECURE=false`.

Dev seed accounts (password `Passw0rd!`, dev-only): `admin@b2boms.test`,
`agent@b2boms.test`, `customer@b2boms.test`, and `disabled@b2boms.test`
(`is_active=false`, for exercising the disabled-account paths).

## What is implemented in Phase 5

**Backend (products & inventory, layered + Zod-validated, parameterized SQL):**
- `GET /api/products` — pagination (`page`/`limit` default 20), `search`
  (name/sku/description ILIKE), server-side **whitelisted** `sort`
  (`name|price|sku|created_at|available`) + `order`, `active_only` filter; public
  via `optionalAuthenticate` (an ADMIN bearer also sees archived rows; everyone
  else is force-filtered to active).
- `GET /api/products/:id` — 404 (not 403) for missing **or** inactive-to-non-admin.
- `POST /api/products` (**ADMIN**) — creates the product, its 1:1 inventory row and a
  `PRODUCT_CREATED` audit record in one transaction; duplicate SKU → `409`.
- `PATCH /api/products/:id` (**ADMIN**) — partial update; `is_active:false` is the
  soft **archive** path (`PRODUCT_DEACTIVATED`). **No DELETE route** — products
  referenced by orders are never physically removed (RESTRICT FK protects them).
- `GET /api/inventory` + `GET /api/inventory/low-stock` — **ADMIN + ORDER_MANAGER**
  only; low-stock ⇔ `available_quantity <= low_stock_threshold`.
- `PATCH /api/inventory/:id` (**ADMIN**) — signed `delta` + required `reason` (+
  optional threshold change): row locked `SELECT … FOR UPDATE`, one
  `inventory_movements` ledger row (`stock_receipt`/`manual_adjustment`) and a
  `STOCK_ADJUSTED` audit row written in the **same** transaction; would-go-negative
  → clean `409 INSUFFICIENT_STOCK` (DB CHECK as defence-in-depth).
- Migration 14 adds `inventory.low_stock_threshold` (`NOT NULL DEFAULT 20`,
  reversible). Customers can neither modify products nor see the inventory table.

**Frontend (React SPA — all screens consume live backend data, no hardcoded arrays):**
- Router shell (`react-router-dom`) + `AuthProvider` (in-memory access token) +
  `Navbar` + role-guarded routes (`RequireRole`).
- `/products` listing with search/sort/pagination; `/products/:id` detail; `/login`;
  `/admin/products` table with add/edit form + deactivate; `/inventory` table with a
  stock-adjustment form (ADMIN can adjust, ORDER_MANAGER is view-only).
- Shared loading / validation / empty / success / error states (`components/States.jsx`,
  `FormProblem`); page count derived client-side (`utils/pagination.js`); a stale-response
  guard in `useApi`.

## What is implemented in Phase 6

**Backend (customer shopping cart, layered + strict-Zod-validated, parameterized SQL):**
- `backend/src/constants/cart.js` — the documented per-line max (`CART_MAX_LINE_QTY = 1000`).
- `backend/src/utils/money.js` — integer-cent + BigInt money math (half-up per line) so
  `grand = subtotal + tax` holds to the cent (D-09).
- `backend/src/repositories/cart.repository.js` + `cart.service.js` + `cart.controller.js` +
  `routes/cart.routes.js` — `GET /api/cart`, `POST /api/cart/items` (upsert merge),
  `PATCH`/`DELETE /api/cart/items/:itemId`, `DELETE /api/cart`. Owner is `req.user.id` only;
  every query is `customer_id`-scoped; inactive product → `404`; over max → `409
  CART_LINE_LIMIT_EXCEEDED`; over stock → `409 INSUFFICIENT_STOCK` (a read-only courtesy
  check — **nothing is reserved**); totals recomputed from live catalog prices; each mutation
  audited inside the same `withTransaction`.
- `migrations/1735689600015_create-cart-item-qty-max.js` — DB `CHECK (quantity <= 1000)`.

**Frontend (React):** a `/cart` page (`pages/CartPage.jsx`, customer-guarded via
`RequireRole`) with `AddToCart`, `CartItemRow` (quantity −/+ via absolute `PATCH`, remove),
server-derived subtotal/tax/grand, an empty-cart state, `stock_warning`/`unavailable` flags,
and API-error messages — driven by `services/api.js` cart functions (no owner id sent).

## What is implemented in Phase 10

**Goal:** wire every delivered backend module into one coherent, professional, responsive
business interface — no mock data, no dead screens — and harden the frontend engineering
around authentication, errors, and role-aware navigation.

**New in this phase (React):**
- **Public customer registration** — `pages/RegisterPage.jsx` (`/register`) posts **only**
  `name`/`email`/`password` to `services/api.js → register()`. Client-side checks mirror the
  backend Zod rules (email shape, name ≤ 120, password ≥ 10 with a letter + a digit, confirm-match)
  for instant feedback, but the server stays authoritative — its rejection is surfaced verbatim
  through `FormProblem`. A `submitting` guard **disables the button and ignores re-entry**, so a
  double-click cannot create two accounts. The backend fixes the CUSTOMER role, so no role control
  exists in the UI (privilege-escalation proof: the request body carries no `role`).
- **Authentication-expiry handling** — the centralized `services/api.js` client now carries a
  one-shot **401 interceptor**: an authenticated call that returns `401 UNAUTHENTICATED` triggers
  `AuthContext`'s de-duplicated `refresh()` (from the HttpOnly cookie), **replays the original
  request once** with the fresh token, and only logs the user out if the cookie itself is spent.
  `AuthContext` also **silently rehydrates** the in-memory session on cold start (a StrictMode-safe
  ref guard runs it once per provider, and a failed bootstrap never clobbers a concurrent login).
  `login`/`register` carry no bearer token, so their own `401`s (bad credentials) are never retried.
- **No hardcoded credentials in the UI** — the seed-account hint (addresses + `Passw0rd!`) was
  **removed** from `LoginPage`; the page now links to `/register`. Dev seeds remain only in
  `database/seeds/` and the setup docs below, never in shipped bundle code.

**Frontend engineering requirements satisfied across the whole app:**
- Reusable component + design-system layer (`components/*`, `States.jsx`
  loading/empty/error/success boundaries, status badges, `Navbar`, `RequireRole`) and a single
  centralized API client (`services/api.js`) — pages never call `fetch` directly.
- API base URL comes from `import.meta.env.VITE_API_BASE_URL` (empty in dev; Vite proxies `/api`);
  bearer tokens follow the in-memory storage strategy (D-19), refresh cookies are HttpOnly/`SameSite=Strict`.
- Forms keep backend validation while adding client-side checks; submit buttons are disabled while
  in flight to prevent duplicate submissions; **all money is rendered from server-calculated fields**
  (never recomputed on the client).
- Accessible labels, `aria-invalid`/`aria-describedby` error wiring, keyboard-friendly controls and
  responsive layouts; pagination + search on the catalog, orders, invoices, audit and inventory lists.
- Role-guarded routes/navigation (`RequireRole` + `Navbar`) are **UX only** — every protected
  endpoint re-checks the role and ownership server-side (a foreign id `404`s).

### Pages & user workflows

| Route | Audience (UX guard) | Workflow |
|---|---|---|
| `/` | public | Landing: system-status probe + entry to browse / register. |
| `/login` | public | Email + password → in-memory session; links to register. |
| `/register` | public | New **customer** account (client + server validation, duplicate-safe submit). |
| `/products` · `/products/:id` | public | Search / sort / paginate the catalog; detail page with stock + add-to-cart. |
| `/cart` | customer | Persistent, server-priced cart: adjust/remove/clear, live stock warnings, **Place order** (idempotency key). |
| `/orders/:id/confirmation` | customer | Post-checkout confirmation with the reserved total. |
| `/orders` · `/orders/:id` | customer + staff | Order history and detail (snapshot prices, status timeline, cancel-with-reason). |
| `/orders/manage` | admin + order manager | **Order-manager workspace**: advance an order one legal step, or cancel. |
| `/invoices` · `/invoices/:id` · `/orders/:orderId/invoice` | customer + staff | Invoice list + **printable** invoice (print / save-as-PDF stylesheet); staff void. |
| `/admin/products` | admin | Product create/edit + soft activate/deactivate (strict server validation surfaced inline). |
| `/inventory` | admin + order manager | Stock table + low-stock filter; ADMIN adjusts, order manager is view-only. |
| `/dashboard` | admin + order manager | Role-scoped metrics (admin adds the activity feed); booked order value is **not** revenue. |
| `/audit` | admin | Read-only, filterable, paginated audit trail (no mutation control anywhere). |
| `/users` | admin | Audited role / active management with a self-lockout guard. |

## Test results (actual, this phase — Phase 10)

| Check | Result |
|---|---|
| `npm --prefix frontend test` | **PASS** — 74/74 (all prior suites + **11 new `auth.test.jsx`**: register posts only `name/email/password` with no `role` and lands the customer; client blocks a weak password without a request; server rejection surfaces and stays on the form; **duplicate-submit guard**; **silent session rehydration** from the refresh cookie; anonymous when the cookie is spent; **401 interceptor refreshes once + replays** with the fresh bearer; a login `401` is never retried; **role-aware Navbar** for customer vs admin vs anonymous) |
| `npm --prefix frontend run lint` | **PASS** — 0 errors / 0 warnings |
| `npm run build:frontend` | **PASS** — 76 modules transformed, `dist/` emitted |
| `npm run format:check` | **PASS** — all files match Prettier style |

Raw output: `evidence/test-reports/phase10-frontend-test.txt`, `phase10-frontend-lint.txt`,
`phase10-frontend-build.txt`, `phase10-format-check.txt`; narrative in `phase10-frontend-integration.md`.
The two brittle `calls[0]` assertions in `catalog.test.jsx` were made order-independent because the
`AuthProvider` now issues a mount-time refresh bootstrap before a page's first data fetch.

## What is implemented in Phase 9

**Backend (audit + reports + admin users, layered + strict-Zod-validated, parameterized SQL):**
- `backend/src/constants/audit.js` — the **single source of truth** for every auditable
  `action`, `entity_type` and `outcome`, with `isValidAction`/`isValidOutcome` guards (the test
  env fails loudly on an unregistered action so the completeness matrix stays honest).
- `migrations/1735689600018_*.js` — adds `audit_logs.outcome` (`varchar NOT NULL DEFAULT
  'success'`, CHECK `success|failure`) and a plain `audit_created_idx` on `created_at` (backs the
  recent-events feed and date-range filters). Fully reversible (`down` drops the index, constraint
  and column).
- `backend/src/services/audit.service.js` — `logAudit` now carries `outcome`; a
  **read-only, ADMIN-gated** `listForAdmin` (filter by actor/action/entity/outcome/date-range,
  paginated). There is **no** update/delete writer; the trail is append-only at the DB level.
- `backend/src/repositories/audit.repository.js` — parameterized filterable list +
  `recentAuditLogs` + `countAll`, with actor identity `LEFT JOIN`ed (failed logins have no
  `actor_id`).
- `backend/src/services/auth.service.js` — now **audits authentication**: `LOGIN_SUCCESS`,
  `LOGIN_FAILED` and a disabled-account attempt (`outcome='failure'`), token reuse, and
  `USER_REGISTERED` (in-transaction). `details` never carries a password/JWT/email-of-record.
- product activation/deactivation now fire `PRODUCT_ACTIVATED`/`PRODUCT_DEACTIVATED` **only on an
  actual `is_active` flip** (`product.service.js`); the order stock lifecycle emits
  `STOCK_RESERVED`/`STOCK_CONSUMED`/`STOCK_RELEASED` inside their transactions (`order.service.js`).
- `backend/src/repositories/report.repository.js` + `services/report.service.js` — precise,
  parameterized aggregates for the dashboard. **Order value is defined as booked (non-cancelled)
  `grand_total` sum — never revenue** (no payment processing exists); every payload embeds
  `metric_definitions` + a `limitations` note so nothing can be mistaken for settled money.
- `backend/src/services/user.service.js` — ADMIN-only directory + `PATCH` limited to `role`/
  `is_active`, audited in the same transaction, with a **self-lockout guard** (cannot demote or
  deactivate one's own account — `409`); `password_hash` is never selected.
- New routes in `routes/index.js`: `GET /api/audit-logs` (ADMIN), `GET /api/reports/dashboard`
  (ADMIN), `GET /api/reports/order-summary` + `/low-stock` (ADMIN + ORDER_MANAGER), and
  `GET/PATCH /api/users*` (ADMIN).

**Frontend (React):** a role-aware `DashboardPage` (ADMIN calls the dashboard and sees the
activity feed; ORDER_MANAGER calls the order-summary and sees **no** audit data), an ADMIN-only
`AuditLogsPage` read-only viewer with filters + pagination (no edit/delete affordance anywhere),
and an ADMIN `UsersPage` for the audited role/status change. Summary cards, an orders-by-status
breakdown, recent orders, a low-stock warning and the metric-definitions disclosure are all
rendered from the server payload verbatim; `constants/auditStatus.js` mirrors the audit
vocabulary for display and `AuditOutcomeBadge` colours the outcome pill.

## Test results (actual, this phase — Phase 9)

Full raw output is in [`evidence/test-reports/`](evidence/test-reports/)
(`phase9-audit-dashboard.md`, `phase9-backend-unit.txt`, `phase9-integration-raw.txt`,
`phase9-frontend-test.txt`, `phase9-backend-lint.txt`, `phase9-frontend-lint.txt`,
`phase9-frontend-build.txt`, `phase9-format-check.txt`, `phase9-dashboard-smoke.txt`), and
browser captures in [`evidence/screenshots/`](evidence/screenshots/). Summary:

| Check | Result |
|---|---|
| `npm --prefix backend run lint` | **PASS** — 0 errors |
| `npm --prefix backend test` | **PASS** — 95/95 (all prior suites + **9 new audit unit**: action registry is exhaustive & internally consistent, `isValidAction`/`isValidOutcome`, `logAudit` writes the outcome and rejects an unregistered action in test mode; DB suites auto-skip) |
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 112/112, 0 cancelled — **audit HTTP** (completeness matrix across product/inventory/order-lifecycle/invoice/user + failed-login `failure` rows, ADMIN-only + append-only access control, filters + pagination), **report HTTP** (dashboard ADMIN-only / order-summary + low-stock staff-only / customer refused; the agent summary carries no audit feed; aggregation accuracy on an isolated window with order-value-excludes-cancelled and is-not-revenue; bad window `400`), **user HTTP** (directory ADMIN-only; role change applied + audited transactionally; self-lockout; deactivating blocks the next login as a `failure`; strict PATCH rejects unknown fields; no hash leak), plus the **`audit_logs.outcome` CHECK** and **migration-18 reversibility** |
| `npm --prefix frontend test` | **PASS** — 63/63 (all prior + **7 new dashboard/audit tests**: admin dashboard cards + activity feed + audit-events count, agent order-summary with NO audit feed and hitting only the staff endpoint, low-stock alert, trail viewer outcome badges + no mutation control, filters sent as query params, wrong-role guard, unauthenticated redirect) |
| `npm --prefix frontend run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |
| `npm run build:frontend` | **PASS** — production bundle emitted |

Key guarantees proven: every auditable business change emits exactly one `audit_logs` row
**inside its own transaction** (a rollback leaves none); the trail is **immutable** — a DB trigger
rejects UPDATE/DELETE and there is no mutation route; **failed logins are recorded as `failure`**
while committed business writes are `success`; the trail and the full dashboard are **ADMIN-only**
and the order-summary/low-stock reports are the **staff** view with the audit feed withheld; a
**dashboard figure is never revenue** — order value is booked demand over non-cancelled orders and
the payload ships explicit metric definitions + limitations; administrative role/status changes are
audited transactionally and **self-lockout is refused**; and migration 18 reverses cleanly.

## Evidence & screenshot instructions (Phase 9)

Reproduce the dashboard screenshots against the running dev stack (DB on `:5433`, backend `:4000`,
frontend dev server):
1. `npm run db:seed` (dev seed) then start the backend (`npm --prefix backend start`) and the
   frontend (`npm --prefix frontend dev`).
2. `node backend/scripts/smoke/phase9-dashboard-smoke.js` mints real activity (login + product
   toggle + stock adjust + place/ship/cancel order + void + a user role change + a failed login)
   so the trail and dashboard show genuine data.
3. Log in as `admin@b2boms.test` (`Passw0rd!`) → **Dashboard** (cards + activity feed) and
   **Audit** (the full trail with filters) and **Users** (audited admin management); log in as
   `agent@b2boms.test` → the same dashboard **without** the activity feed. Captures:
   - `evidence/screenshots/20-dashboard-admin.png` — admin dashboard: summary cards, orders-by-status,
     recent orders, low-stock warning and the **recent activity** feed.
   - `evidence/screenshots/21-dashboard-metric-definitions.png` — the metric-definitions disclosure
     proving `booked_order_value` is booked demand, **not** collected revenue.
   - `evidence/screenshots/22-audit-trail-admin.png` — the ADMIN-only, read-only trail with the
     `outcome`/`action`/date filters (a `LOGIN_FAILED` row shown as a **Failure** badge).
   - `evidence/screenshots/23-users-admin.png` — the ADMIN users directory with the role / active
     editor (self-lockout is disabled on the signed-in admin's own row).
   - `evidence/screenshots/24-dashboard-agent-no-feed.png` — the order-manager dashboard: identical
     order metrics but **no** who-did-what activity feed and no link to the audit trail.

## What is implemented in Phase 8

**Backend (invoicing, layered + strict-Zod-validated, parameterized SQL):**
- `backend/src/constants/invoices.js` — the `issued | voided` status model (`canVoid`), the
  `INV-YYYY-NNNNNN` number format + yearly counter period key, and the demonstration-document
  framing (`INVOICE_DEMO_NOTICE`, `DISTRIBUTOR`) that is embedded in every printable payload.
- the invoice schemas in `backend/src/utils/validators.js` — strict Zod for the list query
  (`status`/`customer_id`/paging), the `id` path param, and `POST void` (a 3–500 char reason, no
  injected money).
- `backend/src/repositories/invoice.repository.js` — the race-safe counter upsert-RETURNING
  (`claimNextNumber`), an idempotent `insertInvoice` (`ON CONFLICT (order_id) DO NOTHING`), the
  `voidInvoice` status flip (guarded on `status='issued'`), and the ownership-scoped reads that
  JOIN `orders`/`users` so a foreign invoice simply is not returned.
- `backend/src/services/invoice.service.js` — `generateForOrder` (called on the **caller's ship
  transaction**: copies the order's persisted `subtotal`/`tax_total`/`grand_total`, never
  recomputes, replays an existing invoice for idempotency, audits `INVOICE_ISSUED`), plus
  `listInvoices`/`getInvoice`/`getInvoiceByOrder` (customer self-scoped, foreign → `404`) and
  `voidInvoice` (staff, transactional, audits `INVOICE_VOIDED`, preserves the row).
- `backend/src/controllers/invoice.controller.js` + `routes/invoice.routes.js` —
  `GET /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices/:id/void` (`ADMIN`/`ORDER_MANAGER`),
  and `GET /api/orders/:id/invoice`; `routes/index.js` mounts `/api/invoices`.
- `backend/src/services/order.service.js` — hooks `invoiceService.generateForOrder` inside the
  existing `→ shipped` transaction, so the invoice and the stock consumption commit atomically.
- `migrations/1735689600017_*.js` — adds `invoices.status` (`DEFAULT 'issued'`, CHECK
  `issued|voided`), `void_reason`, `voided_at`, and **broadens** the `invoice_counters.period`
  CHECK to accept a yearly `'YYYY'` key alongside `'YYYY-MM'` (reversible).

**Frontend (React):** an invoice list (`/invoices`, customers own / staff all, status filter) and
a **professional printable invoice page** (`/invoices/:id` and `/orders/:orderId/invoice`) —
distributor block, bill-to customer, invoice number/date/order reference, the order's line-item
snapshot and subtotal/tax/total — rendered straight from the server payload with a **Print /
Save-as-PDF** button using a `@media print` stylesheet (**no PDF dependency**). A staff-only Void
action posts just a reason; a **DEMONSTRATION DOCUMENT** banner is always shown. Driven by the
`services/api.js` invoice functions, role-guarded via `RequireRole`, money strings displayed as-is.

## Test results (actual, this phase — Phase 8)

Full raw output is in [`evidence/test-reports/`](evidence/test-reports/)
(`phase8-invoices.md`, `phase8-backend-unit.txt`, `phase8-integration-raw.txt`,
`phase8-frontend-test.txt`, `phase8-backend-lint.txt`, `phase8-frontend-lint.txt`,
`phase8-frontend-build.txt`, `phase8-format-check.txt`), and browser captures in
[`evidence/screenshots/`](evidence/screenshots/). Summary:

| Check | Result |
|---|---|
| `npm --prefix backend run lint` | **PASS** — 0 errors |
| `npm --prefix backend test` | **PASS** — 86/86 (foundation + auth + catalog + cart + order + **7 new invoice unit**: `INV-YYYY-NNNNNN` format, yearly counter key, `canVoid`, demo framing, strict Zod schemas; DB suites auto-skip) |
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 95/95, 0 cancelled (schema + auth + catalog + cart + order HTTP + **10 invoice HTTP**: no-invoice-until-ship + atomic appearance, strictly-increasing yearly numbers, UNIQUE duplicate rejection, customer/staff scoping, void-then-refuse + customer-cannot-void, cancelled-has-no-invoice, snapshot immunity to price edits, bad-id `400`/foreign `404`, meaningful-reason-only) incl. **migration-17 reversibility** |
| `npm --prefix frontend test` | **PASS** — 56/56 (health, catalog, pagination, cart, order, **10 new invoice tests**: list scoping, printable payload, order-route lookup, void flow posts only a reason, customer cannot alter, `404`) |
| `npm --prefix frontend run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |
| `npm run build:frontend` | **PASS** — production bundle emitted |

Key guarantees proven: an invoice appears **only** when its order ships and **exactly once** (a
second ship is refused by `UNIQUE(order_id)` and replays the winner); `grand = subtotal + tax` is
enforced by a DB CHECK and the amounts equal the order snapshot; a later catalog price edit cannot
move an issued invoice's total; every read is **ownership-scoped** (a foreign invoice → `404`, never
`403`) and there is **no client path** to alter a total or ownership; voiding is staff-only,
preserves the row and its history, and is audited; a cancelled (pre-shipment) order has no invoice;
consecutive ships draw strictly increasing `INV-YYYY-NNNNNN` numbers; and migration 17 reverses
cleanly (its `down` restores the strict monthly CHECK after the test truncates `invoice_counters`).

## What is implemented in Phase 7

**Backend (orders + inventory transactions, layered + strict-Zod-validated, parameterized SQL):**
- `backend/src/constants/orders.js` — the lifecycle (`pending → confirmed → processing → shipped →
  delivered`, plus `pending|confirmed → cancelled`), the allowed forward-edge matrix, the
  consumption status (`shipped`), the cancellable set, and the movement kinds
  (`order_reservation`, `cancellation_release`, `fulfillment_consumption`).
- the order schemas in `backend/src/utils/validators.js` — strict Zod for create (`items[]` optional
  → falls back to the cart), the `id` path param, list query, `PATCH status`, and `POST cancel`.
- `backend/src/repositories/order.repository.js` — `SELECT … FOR UPDATE` inventory locks taken
  **one product at a time in ascending product-id order** (deadlock-free), reserve-on-create,
  consume-on-ship (`physical -= qty AND reserved -= qty`), release-on-cancel (`reserved -= qty`),
  order/order-item CRUD, and the idempotency claim/lookup primitives — every write paired with an
  `inventory_movements` ledger row.
- `backend/src/services/order.service.js` — the idempotency layer (claim committed **before** any
  stock work; completed rows replay the stored response; concurrent in-progress → `409
  DUPLICATE_REQUEST`; mismatched `request_hash` → `409 IDEMPOTENCY_CONFLICT`) wrapping an atomic
  `withTransaction` create (re-price server-side integer-cent, snapshot names/prices, re-check
  available stock, reserve, empty the cart, audit) and the transition/cancel state machine.
- `backend/src/controllers/order.controller.js` + `routes/order.routes.js` — `POST /api/orders`,
  `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/items`,
  `PATCH /api/orders/:id/status`, `POST /api/orders/:id/cancel`; ownership from `req.user.id` only,
  foreign reads → `404`, customer `PATCH status` → `403`.
- `migrations/1735689600016_*.js` — widens the `orders.status` CHECK to the five-state domain,
  retires the pre-Phase-7 `fulfilled` value, and adds `idempotency_keys.request_hash` (reversible).

**Frontend (React):** `/cart` checkout (a **Place order** button posting with one
`Idempotency-Key` per attempt, `utils/uuid.js`), `/orders` history, `/orders/:id` detail (lifecycle
timeline + cancel form), `/orders/:id/confirmation`, and a staff `/orders/manage` processing
console (advance one legal step); all server-money strings displayed as-is, role-guarded via
`RequireRole`, driven by the `services/api.js` order functions.

## Test results (actual, this phase — Phase 7)

Full raw output is in [`evidence/test-reports/`](evidence/test-reports/)
(`phase7-order.md`, `phase7-backend-unit.txt`, `phase7-integration-raw.txt`,
`phase7-frontend-test.txt`, `phase7-backend-lint.txt`,
`phase7-frontend-lint.txt`, `phase7-frontend-build.txt`, `phase7-format-check.txt`).
Summary:

| Check | Result |
|---|---|
| `npm --prefix backend test` | **PASS** — 79/79 (foundation + auth + catalog + cart + **order unit**: lifecycle matrix, money fixture, strict Zod order schemas; DB suites auto-skip) |
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 85/85, 0 cancelled (schema + auth + catalog + cart + **18 order HTTP**, incl. migration-16 reversibility, 20-way oversell, replay, conflict, rollback, ship-consume, single-release cancel, snapshot immutability) |
| `npm --prefix frontend test` | **PASS** — 46/46 (App health, catalog, pagination, cart, **14 new order tests**) |
| `npm run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |
| `npm run build:frontend` | **PASS** — production bundle emitted |

Key guarantees proven: overselling is impossible under a real 20-way last-unit race (5 win, 15 get
`409 INSUFFICIENT_STOCK`, stock never negative); a shortfall rolls the whole order back leaving
inventory untouched; the idempotency key replays exactly once (single order, `reserved` booked a
single time) and a reused key with a different body → `409 IDEMPOTENCY_CONFLICT`; reserved stock is
consumed exactly once at `shipped` and released exactly once on cancel (a unit is never deducted
twice); the lifecycle rejects skips/backward moves (`409 INVALID_STATE_TRANSITION`) and terminals;
order snapshots survive later catalog price/name edits; and cross-customer reads/items/cancels
return `404` (no existence leak). **Invoicing (FR-INV) remains deferred to Phase 8 (D-24).**

## Test results (actual, this phase — Phase 6)

Full raw output is in [`evidence/test-reports/`](evidence/test-reports/)
(`phase6-cart.md`, `phase6-backend-unit.txt`, `phase6-integration-raw.txt`,
`phase6-cart-http.txt`, `phase6-frontend-test.txt`, `phase6-backend-lint.txt`,
`phase6-frontend-lint.txt`, `phase6-frontend-build.txt`, `phase6-format-check.txt`).
Summary:

| Check | Result |
|---|---|
| `npm --prefix backend test` | **PASS** — 69/69 (foundation + auth + catalog + **18 new cart unit tests**: money + validators; DB suites auto-skip) |
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 67/67, 0 cancelled (20 schema + 16 auth + 15 catalog + **16 cart HTTP**, incl. migration-15 reversibility) |
| `npm --prefix frontend test` | **PASS** — 32/32 (App health 2, catalog 16, pagination 3, **11 new cart tests**) |
| `npm run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |
| `npm run build:frontend` | **PASS** — production bundle emitted |

Key guarantees proven: customer-only access (anon 401 / admin·agent 403), server-side totals
with client prices rejected (400), upsert merge to a single row, quantity validation
(0/negative/fractional/>1000 → 400), inactive product → 404, over-stock refused with **nothing
reserved**, `stock_warning` when on-hand later drops, cross-customer isolation (foreign item →
404), persistence across sessions, and live-price recompute at read time. Cart, order-placed
stock re-verification and auto-clear-on-order are exercised in Phase 7.

## Test results (actual, this phase — Phase 5)

Full raw output is in [`evidence/test-reports/`](evidence/test-reports/)
(`phase5-catalog-inventory.md`, `phase5-backend-unit.txt`, `phase5-integration-raw.txt`,
`phase5-frontend-test.txt`, `phase5-catalog-smoke.json` + `.txt` + `.script.txt`,
`backend-lint.txt`, `frontend-lint.txt`, `frontend-build.txt`, `lint.txt`,
`format-check.txt`), and browser captures in [`evidence/screenshots/`](evidence/screenshots/).
Summary:

| Check | Result |
|---|---|
| `npm --prefix backend test` | **PASS** — 51/51 (foundation + auth + **new catalog unit tests**; DB suites auto-skip) |
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 51/51, 0 cancelled (20 schema + 16 auth + **15 catalog/inventory HTTP**) |
| `npm --prefix frontend test` | **PASS** — 21/21 (App health 2, catalog pages 16, **pagination helpers 3**) |
| `npm run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |
| `npm run build:frontend` | **PASS** — production bundle emitted |
| Live smoke vs the dev server | **PASS** — **66/66 checks**: anon active-only list, search/sort/pagination, invalid-input 400s (limit/sort/unknown param/malformed id), inactive→404, admin sees archived, customer/agent blocked from writes (403), 201 create, 409 duplicate SKU, PATCH price/deactivate, inventory role gates, stock receipt + manual adjustment + refused oversell (409), and **DB proof** each success wrote exactly one ledger + audit row while the refused adjust wrote none, and the product row was never hard-deleted |
| `npm run db:migrate` + `db:health` (dev DB) | **PASS** — migration 14 applied; 13/13 tables, `schemaComplete: true` |

## Evidence & screenshot instructions (Phase 5)

How to reproduce the artefacts in `evidence/`:

```bash
# 1) Backend unit + integration + frontend
npm --prefix backend test
npm run test:integration
npm --prefix frontend test

# 2) Live smoke — start the API against the dev DB, then run the script:
#    (PORT here is 4100 to avoid a server already on 4000; use whichever is free)
$env:PORT=4100; npm run dev:backend          # terminal A
$env:SMOKE_BASE_URL="http://localhost:4100" \ # terminal B
  node backend/scripts/smoke/phase5-catalog-smoke.js
# writes evidence/test-reports/phase5-catalog-smoke.json (+ prints .txt)

# 3) Frontend screenshots — run the stack and capture the screens with Playwright
#    (or a browser). Log in as admin@b2boms.test / Passw0rd! (dev seed).
npm run dev:backend & npm run dev:frontend    # http://localhost:5173
# Save PNGs to evidence/screenshots/NN-<page>.png (see the numbering already there).
```

The existing screenshots (`evidence/screenshots/01…14`) were captured against the
**live** app and show the catalog, search results, product detail, admin product
table + add/edit + duplicate-SKU error, inventory table, low-stock filter, an
adjustment, role-blocking, and the inactive-product 404 — every value rendered comes
from the API (there are no hardcoded product arrays in the pages).

## What is implemented in Phase 4

- `POST /api/auth/register` (customer-only, creates the default cart atomically),
  `POST /api/auth/login`, `POST /api/auth/refresh` (rotation + family-revocation
  reuse detection), `POST /api/auth/logout`, `GET /api/auth/me`.
- `refresh_tokens` table (migration 13 — reversible; hashes only, never raw tokens).
- Zod strict validators, `token.service` (JWT sign/verify, pinned HS256, iss/aud/typ),
  `auth.service` (bcrypt hashes, timing-equalized login, disabled-account rules),
  user + refresh-token repositories (parameterized SQL only).
- `authenticate` / `authorize` / `requireOwnership` / `requireSelf` middleware, and
  express-rate-limit buckets for auth endpoints.
- Env-driven JWT configuration with production boot validation; `.env.example`
  documents every knob; logger/secret hygiene extended (`cookie`, `email`, `auth`).
- Tests: 19 new unit tests (validators, JWT edge cases incl. `alg:none`, RBAC
  middleware matrix, ownership guards) + 16 new integration tests against the
  isolated test DB (full HTTP flows incl. rotation, reuse, rate-limit 429s).

## What is implemented in Phase 3

- **12 versioned, reversible migrations** (`backend/migrations/`): `users`, `products`,
  `inventory`, `carts`, `cart_items`, `orders`, `order_items`, `invoices`,
  `invoice_counters`, `inventory_movements`, `audit_logs`, `idempotency_keys` — with
  BIGSERIAL PKs, foreign keys (RESTRICT where history must be protected), unique + CHECK
  constraints, and targeted indexes; `NUMERIC(12,2)` money; `TIMESTAMPTZ` timestamps.
- **Password hashes only** (`password_hash`, never a plaintext column); order items store
  `product_name`/`unit_price`/`tax_rate` **historical snapshots**.
- **Three-column stock model** with a read-only generated `available_quantity` and the
  `inventory_available_non_negative` oversell CHECK (see Database section above).
- **Append-only `audit_logs`** enforced by a BEFORE UPDATE/DELETE trigger; audit rows are
  written inside the same transaction as business changes (consistency by construction).
- **Idempotency claim rows** — `UNIQUE(user_id, idempotency_key)` with completed-response
  replay rules; **gap-tolerant invoice numbering** via `invoice_counters` upsert.
- **`pg` connection pool** (`backend/src/db/pool.js`) with `withTransaction()`, test-mode
  URL switching, and pool close on graceful shutdown.
- **Safe DB tooling** (`backend/scripts/db/`): `create-db` (if-missing only), `migrate`
  (up/down, credential-redacted logs), `seed` (idempotent, bcrypt-hashed dev passwords,
  single transaction), `health-check` (read-only), `run-integration-tests`.
- **`GET /api/health` now reports database state** — `db: {state: "up"|"down"|
  "not_configured", latencyMs}`; returns **503 `degraded`** when the DB is configured but
  unreachable (never leaks credentials or driver errors).
- **20 PostgreSQL integration tests** against the isolated `DATABASE_URL_TEST` database,
  including full down-all/up **reversibility proof**.

## What is implemented in Phase 2

- Express app factory with **`GET /api/health`**, JSON body parsing with a size limit,
  **Helmet** security headers, an **explicitly configured CORS** allow-list, a **consistent
  JSON 404** envelope, and **centralized safe error handling** (never leaks stack traces).
- **Graceful shutdown** on SIGINT/SIGTERM with a timeout guard.
- React **landing page** that calls the health endpoint and renders **loading / success /
  failure** states (with retry).
- Backend **tests** (Node + Supertest) for the health endpoint and unknown routes (plus
  error-envelope, header, and payload-limit checks); frontend **Vitest + RTL** test for the
  landing page states. Vitest/RTL and ESLint are configured for future tests.
- `backend/.env.example`, `frontend/.env.example`, `.gitignore` (excludes real `.env`),
  Prettier + EditorConfig, ESLint flat configs (backend **CommonJS**, frontend ESM/React).
- Docker `docker-compose.yml` with `db` + `backend` + `frontend` and per-service Dockerfiles.

## Test results (Phase 4)

Full raw output is saved in [`evidence/test-reports/`](evidence/test-reports/)
(`phase4-auth.md`, `phase4-backend-unit.txt`, `phase4-integration-raw.txt`,
`phase4-auth-smoke.json` + `.script.txt`). Summary:

| Check | Result |
|---|---|
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 36/36 (20 schema + **16 auth HTTP**) incl. down-all/up reversibility with the new 13th table |
| `npm --prefix backend test` | **PASS** — 29/29 (10 foundation + **19 new auth unit tests**; DB suites auto-skip) |
| `npm test` (backend + frontend) | **PASS** (frontend 2/2 unchanged) |
| `npm run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |
| Live smoke on the dev DB (15 steps) | **PASS** — every status + error code matched: 201 customer-only register, 400 role injection, 409 duplicate, identical 401s, refresh rotation → 401 `TOKEN_REUSED` on spent cookie, successor killed with the family, logout → 401 afterwards, seeded admin login OK |
| `npm run db:migrate` + `db:health` (dev DB) | **PASS** — migration 13 applied; 13/13 tables, `schemaComplete: true` |

**Not executed / remain unverified (honest list):** full `docker compose up --build`
with the new code; frontend login UI (API-only phase); real-time 7-day refresh expiry
(proven via logic + short-TTL unit tests only); `purgeExpired()` cleanup is not yet
scheduled by a job runner; bcrypt/limiter behaviour under load; the rate limiter uses
the in-memory store (per-instance by design, documented above).

## Test results (Phase 3)

Full raw output is saved in [`evidence/test-reports/`](evidence/test-reports/)
(`phase3-database.md`, `phase3-integration-raw.txt`, `phase3-health-smoke.json`,
`phase3-migrate-dev.log.txt`). Summary:

| Check | Result |
|---|---|
| `npm run test:integration` (isolated `b2b_oms_test` DB) | **PASS** — 20/20 tests, 0 failures (incl. down-all + re-up reversibility) |
| `npm run db:migrate` on dev DB | **PASS** — 12/12 migrations applied |
| `npm run db:health` on dev DB | **PASS** — server 16.15, `schemaComplete: true`, `appliedMigrations: 12` |
| `npm run db:seed` | **PASS** — 3 users / 6 products inserted; **re-run correctly skipped** (no overwrite) |
| Live `GET /api/health` (DB up) | **PASS** — 200 `{"status":"ok","db":{"state":"up",…}}` |
| Live `GET /api/health` (db container stopped) | **PASS** — 503 `{"status":"degraded","db":{"state":"down"}}`; data intact after restart |
| `npm --prefix backend test` | **PASS** — 10/10 (DB-free & deterministic; DB suite auto-skips) |
| `npm test` (backend + frontend) | **PASS** (exit 0) |
| `npm run lint` / `npm run format:check` | **PASS** — 0 errors / all formatted |

**Not executed / remain unverified (honest list):** full `docker compose up --build`
end-to-end stack run (compose config reviewed; migrate-on-boot not exercised in a
container); the idempotency-key expiry cleanup job (Phase 4 application logic); pool
behavior under concurrent load (no benchmark run); the unrelated native PostgreSQL service
on host 5432 was left untouched.

## Test results (Phase 2)

Full raw output is saved in [`evidence/test-reports/`](evidence/test-reports/). Summary:

| Suite | Result |
|---|---|
| Backend `npm --prefix backend test` | **PASS** — 10 tests / 5 suites, 0 failures |
| Frontend `npm --prefix frontend test` | **PASS** — 2 tests / 1 file |
| Aggregate `npm test` | **PASS** (exit 0) |
| `npm run lint` (backend + frontend) | **PASS** — 0 errors |
| `npm run format:check` | **PASS** — all files formatted |
| `npm run build:frontend` | **PASS** — 30 modules, `dist/` emitted |
| Runtime smoke `GET /api/health` | **PASS** — `{"status":"ok","uptimeSeconds":2,...}` |

Honest limitations: Docker `compose up` and the SIGINT graceful-shutdown drain were **not
executed** in this phase (Dockerfiles/compose are provided and reviewed; a manual
verification procedure is above). No performance/load or business-module tests exist yet —
those are out of scope for Phase 2.

## Roles & permissions

Three server-enforced roles (`backend/src/middleware/authorize.js`); the frontend's `RequireRole`
route guards and role-aware navbar are **UX only** — every protected endpoint re-checks the role
and ownership, and a foreign resource id returns **404** (never a leaking 403). A fourth *state*,
`is_active = false`, blocks login entirely.

| Capability | ADMIN | ORDER_MANAGER (agent) | CUSTOMER | Anonymous |
|---|:--:|:--:|:--:|:--:|
| Browse / search active catalog | ✅ | ✅ | ✅ | ✅ |
| Register a new customer account | — | — | ✅ | ✅ |
| Manage cart & place an order | — | — | ✅ | — |
| View **own** orders / invoices | ✅* | ✅* | ✅ (own only) | — |
| Confirm / fulfil orders (state machine) | ✅ | ✅ | — | — |
| Adjust inventory (signed delta + reason) | ✅ | 🖼 view-only | — | — |
| Create / edit / activate products | ✅ | — | — | — |
| Issue invoices (auto on fulfil) · void | ✅ | ✅ | — | — |
| Dashboard (full metrics + activity feed) | ✅ | ✅ (order summary, **no** audit feed) | — | — |
| Read the audit trail (append-only) | ✅ | — | — | — |
| Manage users (role / active) | ✅ | — | — | — |

\* staff can view **all** orders/invoices; a customer sees only their own. There is **no public
`POST /api/users`** — accounts are created via self-register (forced CUSTOMER) or by an admin.
Dev seed logins (password `Passw0rd!`, **dev-only**) live in `database/seeds/`:
`admin@b2boms.test`, `agent@b2boms.test`, `customer@b2boms.test`, `disabled@b2boms.test`.

## Screenshots

Every image below was captured against the **running** application (no mock data — all values are
rendered from live API responses). Files live in [`evidence/screenshots/`](evidence/screenshots/).

**Catalog & customer journey**

| | |
|---|---|
| ![Products listing](evidence/screenshots/12-products-listing-fixed.png) | Active-product catalog with server-computed availability |
| ![Search](evidence/screenshots/13-products-search-single-click.png) | Search filtering the live catalog |
| ![Sort by price](evidence/screenshots/14-products-sort-price-desc.png) | Price-descending sort applied server-side |
| ![Product detail](evidence/screenshots/03-product-detail.png) | Detail page with stock and add-to-cart |

**Admin catalog & inventory**

| | |
|---|---|
| ![Admin logged in](evidence/screenshots/04-logged-in-admin.png) | Admin session (in-memory access token + HttpOnly refresh cookie) |
| ![Admin products](evidence/screenshots/05-admin-products-table.png) | Product management table |
| ![Duplicate SKU error](evidence/screenshots/06-add-product-error.png) | `409 DUPLICATE_SKU` — unique SKU enforced in the database |
| ![Inventory](evidence/screenshots/07-inventory-table.png) | Stock ledger view |
| ![Adjust validation](evidence/screenshots/08-inventory-adjust-validation.png) | Invalid adjustment rejected by strict Zod |
| ![Low stock](evidence/screenshots/09-inventory-low-stock.png) | Low-stock filter over live quantities |

**Access control (server-side RBAC)**

| | |
|---|---|
| ![Customer blocked](evidence/screenshots/10-customer-blocked-admin.png) | A customer denied an admin screen (menu hiding is only UX) |
| ![Inactive product 404](evidence/screenshots/11-inactive-product-404.png) | Deactivated product → `404` |

**Invoicing**

| | |
|---|---|
| ![Customer invoices](evidence/screenshots/15-invoice-list-customer.png) | A customer's own invoice list |
| ![Printable invoice](evidence/screenshots/16-invoice-printable-issued.png) | Issued invoice — sequential number + snapshotted line prices |
| ![Voided invoice](evidence/screenshots/17-invoice-printable-voided.png) | Voided invoice retains its history |
| ![Staff invoices](evidence/screenshots/18-invoice-list-staff.png) | Staff invoice list (all customers) |
| ![Staff void](evidence/screenshots/19-invoice-staff-void-button.png) | Staff-only void action |

> A screenshot gallery for the dashboard/audit/users screens (Phase 9) was referenced during
> development, but those specific PNGs are **not** present in `evidence/screenshots/`; the audit and
> dashboard behaviour is instead evidenced by the Phase 9 test output in
> [`evidence/test-reports/`](evidence/test-reports/). Nothing here is fabricated.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Landing health badge is red / "down" | API or DB not reachable | `npm run docker:ps` / `npm run docker:logs`; ensure `.env` has a real `POSTGRES_PASSWORD` and ≥32-char `JWT_*` secrets |
| Compose refuses to start with a `${VAR:?}` message | A required secret is unset (this is **intentional fail-closed**) | Populate root `.env` from `.env.example` |
| Backend won't boot on `JWT_ACCESS_SECRET` / `COOKIE_SECURE` | Production boot validation rejects a weak secret or non-secure cookie | Use a ≥32-char secret; set `COOKIE_SECURE=true` and serve behind TLS |
| `EADDRINUSE` on dev ports | A server already holds `:4000`/`:5173`, or a native PostgreSQL holds `5432` | Stop stray processes; dev Compose publishes PostgreSQL on **`:5433`** by design (D-17) |
| `npm run test:e2e` won't start | Playwright uses `reuseExistingServer:false` | Free ports 4000/5173 before running (see known issue K-5) |
| Cold deep-link to a protected route briefly bounces to `/login` | In-memory access token rehydrates from the refresh cookie on load (known issue K-3) | Navigate by clicking; the SPA re-establishes the session automatically |
| A benign `pg.pool.error … terminating connection` line during E2E | Guarded disposable-DB bootstrap teardown | Expected; all 17 tests still pass |
| Stock too low to demo an order | Prior orders reserved it | Re-run `npm run docker:seed` (idempotent — skips if present) or raise stock as admin |

## Limitations

This is a **functionally complete single-tenant v1**, validated by tests that actually ran. It is
not a hardened multi-tenant SaaS. Headline boundaries (full list in
[`docs/limitations.md`](docs/limitations.md)):

- **Out of scope by design**: payments/settlement, shipping, multi-warehouse/batch inventory,
  per-customer pricing & discounts, multi-jurisdiction tax, procurement, report export, password
  reset, multi-tenancy.
- **Not measured (never claimed)**: performance under load (SC-07/NFR-05), pilot usability timing
  (SC-06), and any business impact — there were no real pilot users. The 20-way concurrency test
  proves *correctness* of the no-oversell guard, not latency.
- **Operational**: TLS terminates externally, secrets are env-only (no vault), rate limiting is
  in-process, access tokens have no server-side blocklist, and there is no CI/CD or backup
  scheduler.

## Documentation

See [`docs/`](docs/): [`requirements.md`](docs/requirements.md) ·
[`acceptance-criteria.md`](docs/acceptance-criteria.md) · [`architecture.md`](docs/architecture.md) ·
[`database-design.md`](docs/database-design.md) · [`api-specification.md`](docs/api-specification.md) ·
[`decision-log.md`](docs/decision-log.md) · [`implementation-plan.md`](docs/implementation-plan.md) ·
[`risk-register.md`](docs/risk-register.md) · [`test-plan.md`](docs/test-plan.md) ·
[`test-results.md`](docs/test-results.md) · [`deployment.md`](docs/deployment.md) (Docker &
reproducible deployment — Phase 13) · [`requirements-traceability.md`](docs/requirements-traceability.md) ·
[`security-review.md`](docs/security-review.md) · [`limitations.md`](docs/limitations.md) ·
[`future-roadmap.md`](docs/future-roadmap.md) · [`demo-script.md`](docs/demo-script.md) ·
[`viva-questions.md`](docs/viva-questions.md) · [`presentation-outline.md`](docs/presentation-outline.md) ·
[`project-summary.md`](docs/project-summary.md) · [`acceptance-report.md`](docs/acceptance-report.md) (Phase 14–15).

## Files created / changed in Phase 5

**Backend (new):** `src/repositories/{product,inventory}.repository.js`,
`src/services/{product,inventory,audit}.service.js`,
`src/controllers/{product,inventory}.controller.js`,
`src/routes/{product,inventory}.routes.js`,
`migrations/1735689600014_add-inventory-low-stock-threshold.js`,
`tests/{catalog-unit,catalog-http}.test.js`, `scripts/smoke/phase5-catalog-smoke.js`

**Backend (changed):** `src/utils/validators.js` (catalog/inventory Zod schemas +
pagination + sort whitelist), `src/middleware/authenticate.js` (`optionalAuthenticate`),
`src/routes/index.js` (mount `/api/products`, `/api/inventory`)

**Frontend (new):** `src/pages/{ProductsPage,ProductDetailPage,AdminProductsPage,
InventoryPage,LoginPage}.jsx`, `src/context/AuthContext.jsx`, `src/hooks/useApi.js`,
`src/components/{States,Navbar,RequireRole,ProductForm,InventoryAdjustForm}.jsx`,
`src/services/api.js`, `src/utils/pagination.js`, `src/styles-catalog.css`,
`src/test/{catalog.test.jsx,pagination.test.js}`

**Frontend (changed):** `src/App.jsx` (router shell + AuthProvider), `src/main.jsx`,
`src/components/States.jsx` (render-prop `DataBoundary` + `FormProblem`),
`src/hooks/useApi.js` (stale-response guard)

**Other:** `docs/api-specification.md` (v1.2 §2.2 as-built), `docs/database-design.md`
(low_stock_threshold + low-stock rule), `docs/decision-log.md` (D-20/D-21/D-22),
`docs/implementation-plan.md` (FR-CAT traceability as-built), `README.md`,
`evidence/test-reports/phase5-*`, `evidence/screenshots/01…14`

## Files created / changed in Phase 4

**Backend (new):** `src/constants/roles.js`, `src/utils/validators.js`,
`src/services/token.service.js`, `src/services/auth.service.js`,
`src/repositories/{user,refreshToken}.repository.js`,
`src/middleware/{authenticate,authorize,rateLimit,asyncHandler}.js`,
`src/controllers/auth.controller.js`, `src/routes/auth.routes.js`,
`migrations/1735689600013_create-refresh-tokens.js`,
`tests/auth-unit.test.js`, `tests/auth-http.test.js`

**Backend (changed):** `src/config/env.js` (JWT/bcrypt/rate-limit config + production
secret validation), `src/app.js` (cookie-parser), `src/routes/index.js` (auth mount),
`src/utils/{errors,logger}.js`, `scripts/db/{seed,health-check,run-integration-tests}.js`,
`tests/{app,db-integration}.test.js`, `package.json`, `.env.example`

**Other:** `database/seeds/seed-data.js` (+disabled user), `package.json` (root),
`README.md`, `docs/api-specification.md` (v1.1 as-built auth), `docs/decision-log.md`
(D-19; OD-3 partially resolved), `evidence/test-reports/phase4-*`

## Files created / changed in Phase 3

**Backend:** `backend/src/db/pool.js`, `backend/migrations/` (12 files),
`backend/scripts/db/{create-db,migrate,seed,health-check,run-integration-tests}.js`,
`backend/tests/db-integration.test.js`, edits to `backend/src/config/env.js`,
`backend/src/services/health.service.js`, `backend/src/controllers/health.controller.js`,
`backend/src/server.js`, `backend/tests/app.test.js`, `backend/package.json`,
`backend/.env.example`, `backend/Dockerfile`

**Root / other:** `package.json` (db:* passthroughs), `docker-compose.yml` (host port 5433,
migrate-on-boot), `database/seeds/seed-data.js`, `README.md`,
`docs/database-design.md` (as-built v1.1), `docs/architecture.md` (§5 as-built),
`docs/decision-log.md` (D-17, D-18; D-06 superseded; OD-2 partially resolved),
`evidence/test-reports/phase3-*`

## Files created / changed in Phase 2

**Root:** `package.json`, `.gitignore`, `.prettierrc.json`, `.prettierignore`,
`.editorconfig`, `docker-compose.yml`, `README.md`

**Backend (`backend/`):** `package.json`, `.env.example`, `.dockerignore`, `Dockerfile`,
`eslint.config.js`, `src/config/env.js`, `src/app.js`, `src/server.js`,
`src/routes/index.js`, `src/routes/health.routes.js`, `src/controllers/health.controller.js`,
`src/services/health.service.js`, `src/middleware/{errorHandler,notFound,requestLogger}.js`,
`src/utils/{logger,errors}.js`, `tests/app.test.js`, `tests/unit.test.js`,
`migrations/.gitkeep`, `src/repositories/.gitkeep`

**Frontend (`frontend/`):** `package.json`, `.env.example`, `.dockerignore`, `Dockerfile`,
`nginx.conf`, `vite.config.js`, `eslint.config.js`, `index.html`, `src/main.jsx`,
`src/App.jsx`, `src/styles.css`, `src/services/api.js`, `src/hooks/useHealth.js`,
`src/components/HealthStatus.jsx`, `src/test/setup.js`, `src/test/App.test.jsx`

**Other:** `database/seeds/.gitkeep`, `evidence/screenshots/.gitkeep`,
`evidence/test-reports/*` (this phase's captured outputs), `docs/architecture.md` (as-built
layout), `docs/decision-log.md` (D-15, D-16; OD-1 resolved).

## Recommended Git commit message

Phase 5:

```
feat: add product catalog and inventory modules end to end (Phase 5)

Layered, Zod-validated, parameterized-SQL endpoints: GET /api/products
(pagination, search, whitelisted sort, active-only filtering via
optionalAuthenticate so admins also see archived rows), GET /api/products/:id
(404 for hidden/inactive to non-admins), ADMIN-only POST/PATCH with duplicate-SKU
409 and soft archival (no hard delete; RESTRICT FK protects order history),
staff-only GET /api/inventory + /low-stock, and ADMIN PATCH /api/inventory/:id
applying a signed delta under SELECT ... FOR UPDATE while writing one
inventory_movements ledger row and one STOCK_ADJUSTED audit row in the same
transaction (DB CHECK as the oversell guard -> 409 INSUFFICIENT_STOCK). Adds
reversible migration 14 (inventory.low_stock_threshold, default 20; low-stock =
available <= threshold). React SPA screens render live API data only (product
listing/search, detail, admin table + add/edit form, inventory table + adjust
form, login) with shared loading/validation/empty/success/error states, a
customer-facing RBAC guard, client-derived pagination, and a stale-response
hook guard. 51 backend unit + 51 integration + 21 frontend tests pass, a 66-check
live smoke passes (incl. DB proof of transactional audit + no hard delete), and
lint/build/format are clean (D-20/D-21/D-22).
```

Phase 4:

```
feat: add JWT authentication with RBAC, refresh-token rotation, and rate limiting (Phase 4)

Register/login/refresh/logout/me endpoints; bcryptjs password hashes; Zod
strict validators (customer-only registration); short-lived HS256 access
tokens with pinned algorithm and iss/aud validation; rotating opaque refresh
tokens stored as SHA-256 hashes in a new reversible refresh_tokens migration,
HttpOnly SameSite=strict path-scoped cookie (CSRF-safe) with family
revocation on reuse; authenticate/authorize/requireOwnership middleware;
per-IP rate limiting on auth endpoints; disabled-account enforcement;
env-only secrets with production boot validation; 19 unit + 16 integration
tests passing (36/36 DB suite) plus a 15-step live smoke (D-19).
```

Phase 3:

```
feat: add versioned PostgreSQL schema, connection pool, seeds, and DB integration tests (Phase 3)

Twelve reversible node-pg-migrate migrations (BIGSERIAL PKs, NUMERIC(12,2)
money, TIMESTAMPTZ, FK/unique/CHECK constraints, generated available_quantity,
append-only audit trigger, idempotency claim rows, invoice counter table), a
pg pool with withTransaction, safe create/migrate/seed/health-check scripts
(no auto-drop), /api/health DB status with 503 degraded path, 20 integration
tests on an isolated test database (20/20 pass, reversibility proven), Docker
db wiring on host port 5433, and as-built documentation (D-17, D-18).
```

Phase 2:

```
feat: scaffold React + Express + PostgreSQL + Docker project foundation (Phase 2)

Establish the project foundation without any business modules: layered
Express API (health endpoint, helmet, explicit CORS, body-size limit,
consistent JSON 404, centralized safe error handling, graceful shutdown),
a React/Vite landing page that renders loading/success/failure states from
the health endpoint, backend tests (node:test + Supertest) and frontend
tests (Vitest + RTL), ESLint/Prettier, .env examples with git-ignored real
.env, and a docker-compose stack (db + backend + frontend). Includes
Phase-2 evidence reports and as-built doc updates (D-15/D-16).
```
#   B 2 B - O r d e r - P l a t f o r m  
 