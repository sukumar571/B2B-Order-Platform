# Project Summary (GitHub) & LinkedIn Post Draft — B2B Order Management Platform

Everything below is grounded in what was actually built and tested. No user counts, revenue,
or "measured impact" claims are made — none were measured (see [`limitations.md`](limitations.md)).

---

## GitHub — repository "About" (short description field)

> Single-tenant B2B order platform: live-stock ordering, server-priced money, automatic invoicing
> and an append-only audit trail. React + Express + PostgreSQL, tested by 352 automated checks.

Topics/tags: `react` `express` `postgresql` `node-pg-migrate` `docker` `jwt` `rbac` `playwright`
`vitest` `supertest` `zod` `rest-api` `b2b` `order-management`.

## GitHub — README-style long summary

**B2B Order Management Platform** replaces the email-and-spreadsheet order flow for a single
distributor tenant. Customers order against **live, reserved stock**, every line is **re-priced
authoritatively on the server**, fulfilment **mints exactly one invoice**, and **every state change
is written to an append-only audit log** — all enforced server-side, not just hidden in the UI.

**Highlights**
- **Real-time inventory that cannot be oversold** — `SELECT … FOR UPDATE` + a database
  `CHECK (physical − reserved ≥ 0)`, proven by a 20-way concurrency integration test.
- **Decimal-safe money** — `NUMERIC` in Postgres and integer-cent arithmetic in `utils/money.js`;
  totals are always server-computed and invoice totals equal order totals by construction.
- **Secure session model** — bcrypt (cost 12), a short-lived HS512 access token kept in SPA memory
  only, and a rotating refresh token as an HttpOnly/SameSite=Strict/Secure cookie stored as a
  SHA-256 hash with reuse → family revocation.
- **Automatic, race-safe invoicing** — sequential `INV-YYYY-NNNNNN` numbering via a counter upsert,
  issued inside the fulfilment transaction, with a customer/staff-scoped printable view.
- **Layered, validated backend** — routes → middleware → controllers → services → repositories,
  Zod-strict inputs, and 100% parameterized SQL.
- **Reproducible deployment** — multi-stage, non-root Docker images; a one-shot, health-gated
  migration service; fail-fast secrets; same-origin nginx `/api` proxy; PostgreSQL unpublished in
  production; data preserved on a named volume across restarts.

**Stack:** React 18 + Vite (SPA) · Node.js + Express (CommonJS) · PostgreSQL 16 (node-pg-migrate
v7) · Zod · JWT + bcryptjs · Docker Compose · Node test runner + Supertest · Vitest + React Testing
Library · Playwright (Chromium).

**Quality:** 352 automated checks pass with 0 failures — 228 backend (unit + integration), 74
frontend, 17 browser E2E — plus a 9/9 post-deploy smoke test. Line coverage is measured and
disclosed (backend ≈96.3%, frontend ≈88%), not gated by an arbitrary threshold.

**Honest scope:** v1 is single-tenant. Payments, shipping, multi-warehouse/batch inventory,
per-customer pricing, multi-jurisdiction tax, report export, password reset and multi-tenancy are
**out of scope** and documented. Performance-under-load, pilot-usability timing and business impact
were **not measured**. See `docs/limitations.md` and `docs/future-roadmap.md`.

**Quick start**
```bash
cp .env.example .env      # set POSTGRES_PASSWORD + ≥32-char JWT_* secrets
npm ci
npm run docker:up         # db → migrate → backend → frontend  → http://localhost:8080
npm run docker:seed       # idempotent demo data
```

Full documentation lives in [`docs/`](../docs/) — requirements, architecture, database design, API
specification, security review, test plan & results, deployment, limitations, roadmap, traceability,
demo script and viva Q&A.

---

## LinkedIn post (concise draft)

I built **B2B Order Management Platform**, a full-stack ordering system for a distributor that
replaces email-and-spreadsheet orders with live, audited workflows.

What I'm proudest of:
🔒 Real-time inventory that provably **can't be oversold** — row-level locking plus a database
constraint, verified by a 20-way concurrency test.
🧾 Fulfilment **auto-mints an invoice** in the same transaction, so order and invoice totals can
never drift.
🔐 A hardened session model — bcrypt, in-memory short-lived JWTs, and rotating HttpOnly refresh
tokens stored only as hashes, with reuse detection.
🧭 An **append-only audit trail** written inside each business transaction.
📦 One-command, reproducible deployment with `docker compose up`.

Stack: React + Vite · Express · PostgreSQL · Docker · Zod · Playwright.
Validated by **352 automated checks (0 failures)** across unit, integration and browser E2E.

I kept the write-up honest too: it's a single-tenant v1, and I did *not* measure performance under
load or business impact — those, along with the out-of-scope features, are documented as limitations
and next steps rather than glossed over.

Code: <repo URL>

#FullStack #React #NodeJS #PostgreSQL #Docker #SoftwareEngineering #Backend #Testing
