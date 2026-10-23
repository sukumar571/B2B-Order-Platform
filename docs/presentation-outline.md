# Presentation Outline — B2B Order Management Platform

A 10-content-slide deck (plus title) for the Arrowstack internship review. Every figure is drawn
from tests that **actually ran** (see [`test-results.md`](test-results.md)); screenshots reference
the genuine captures in [`../evidence/screenshots/`](../evidence/screenshots/). Suggested speaker
time ≈ 8–10 minutes. Do **not** add performance numbers, user counts, or business-impact claims —
none were measured.

---

### Slide 1 — Title
**B2B Order Management Platform** — a single-tenant React + Express + PostgreSQL app that replaces
email-and-spreadsheet ordering with live-stock orders, server-priced money, automatic invoicing, and
a full audit trail.
Sub-line: *Phases 1–14 delivered · 352 automated checks, 0 failures · runs from one
`docker compose up`.* Presenter name/date.

### Slide 2 — Business problem
- Distributor took orders by email + spreadsheet: stock was a lagging manual count, prices
  recomputed by hand, no single record of who changed what, invoices bolted on afterwards.
- Consequences it caused: overselling, pricing disputes, no traceability, slow fulfilment.
- One-sentence value prop: *customers order against live reserved stock, the server prices every
  line, fulfilment auto-mints an invoice, every change is audited.*
- Visual: landing page with the live `GET /api/health` "connected" badge (proves real API + DB, no mocks).

### Slide 3 — Stakeholders & requirements
- Three roles, enforced server-side: **ADMIN**, **ORDER_MANAGER (agent)**, **CUSTOMER** (+ a disabled
  account state).
- Requirements grouped as: authentication/RBAC, catalog & inventory, cart, orders & lifecycle,
  invoicing, audit & dashboards.
- Key constraints honoured (C-01..C-10): React/Vite, layered Express, PostgreSQL + node-pg-migrate,
  Zod + parameterized SQL, JWT + bcrypt + RBAC, env-only secrets, Docker, single-tenant.
- Visual: the role→capability matrix from [`requirements.md`](requirements.md) §4.

### Slide 4 — Architecture
- Monorepo: `frontend/` (Vite+React SPA) → same-origin nginx `/api` proxy → `backend/`
  (routes → middleware → controllers → services → repositories → PostgreSQL).
- Request flow annotated: JWT auth → per-request user reload → role/ownership guard → Zod validate →
  service transaction → parameterized SQL → audit row in-transaction → central error envelope.
- Diagram: the mermaid flowchart in [`architecture.md`](architecture.md).

### Slide 5 — Database design
- 14 public tables across 18 reversible migrations (13 business + `pgmigrations`).
- Money as `NUMERIC` (never float); three-column stock model
  (`physical_stock`, `reserved_stock`, generated `available_quantity`) with a
  `CHECK (physical - reserved >= 0)` oversell guard.
- Order/invoice line items **snapshot** name & price; `audit_logs` is append-only via a BEFORE
  UPDATE/DELETE trigger.
- Diagram: the mermaid `erDiagram` in [`database-design.md`](database-design.md).

### Slide 6 — Main user workflows
- Admin: create product → reuse SKU refused (`409 DUPLICATE_SKU`) → adjust stock → movement + audit
  row appears.
- Customer: browse/search → add to cart (quantity merges, server-priced totals) → place order (stock
  reserved atomically).
- Agent: confirm → fulfil (skipping a step returns `409 INVALID_STATE_TRANSITION`) → exactly one
  invoice minted.
- Visuals: `evidence/screenshots/05-admin-products-table.png`,
  `12-products-listing-fixed.png`, `16-invoice-printable-issued.png`.

### Slide 7 — Security & data integrity
- AuthN: bcrypt cost 12; short HS512 access token **in memory only**; rotating refresh token as an
  HttpOnly / SameSite=Strict / Secure cookie stored **only as a SHA-256 hash**; reuse → family revoke.
- AuthZ: per-endpoint role checks + ownership (`requireSelf`/`requireOwnership`) → foreign id `404`,
  no leaking `403`; no public user-creation route.
- Integrity: 20-way concurrency test proves no oversell; idempotency-key replay prevents duplicate
  orders; fulfilment + invoice commit in one transaction.
- Secrets hygiene: env-only, fail-fast Compose (`${VAR:?}`), image audit shows `.env count: 0`.
- Detail: [`security-review.md`](security-review.md).

### Slide 8 — Testing & evidence
- **352 automated checks, 0 failures**: backend **228/228** (39 suites, unit + integration incl.
  the 20-way race), frontend **74/74** (Vitest + RTL), browser E2E **17/17** (10 journeys + 7
  negative) on Chromium; Phase 13 deploy smoke **9/9**.
- Coverage measured & disclosed (not gated): backend ~96.34% lines, frontend ~87.76%.
- Honest gaps surfaced: two frontend screens covered by E2E instead of unit; one benign E2E log line.
- Visual: the summary table from [`test-results.md`](test-results.md).

### Slide 9 — Demo results & limitations
- Demo delivered the full lifecycle live (see [`demo-script.md`](demo-script.md)) — every value came
  from the running app; screenshots are genuine captures, not mocks.
- Explicitly **not measured / not claimed**: performance under load (SC-07/NFR-05), pilot usability
  timing (SC-06), and any business impact — no real pilot users existed.
- Scope boundaries: single-tenant, no payments/shipping/multi-warehouse/per-customer pricing; no
  in-container TLS; in-process rate limiting; access tokens have no server-side blocklist.
- Full list: [`limitations.md`](limitations.md).

### Slide 10 — Future roadmap
- **Now (before real traffic):** external TLS, Redis-backed rate limiting + token revocation, managed
  secrets, CI (lint/test/audit/gitleaks/build), a k6 load benchmark to replace "not measured".
- **Next:** structured logging/metrics, digest-pinned + scanned images, rootless web, containerised
  E2E.
- **Later (business features):** payments, per-customer pricing, multi-warehouse stock, password
  reset, report export, multi-tenancy.
- Detail: [`future-roadmap.md`](future-roadmap.md).

### Closing line
*A functionally complete, security-reviewed, fully tested v1 — honest about exactly what was and was
not measured.* Questions.
