# Implementation Plan — B2B Order Management Platform

**Document version:** 1.0 (Phase 1 — Planning & Design)
**Status:** Approved design baseline for Phase 2. No application code exists yet.
**Related:** all other `docs/` files; IDs reference `requirements.md` (FR/NFR), `acceptance-criteria.md` (AC), `decision-log.md` (D), `risk-register.md` (R).

---

## 1. Phase plan

Estimates assume one developer working part-time; durations are working days, calendar-independent.

### Phase 1 — Requirements & Architecture *(this document set)* — done when docs reviewed
Deliverables: the eight `docs/` files, consistency validation, committed baseline.

### Phase 2 — Foundation & Skeleton (est. 3–5 days)
| ID | Task | Delivers | Depends on |
|---|---|---|---|
| M-01 | Repo scaffold: `client/`, `server/`, `e2e/`, `docs/`, `.gitignore`, `.env.example`, README | C-01…C-07 file layout (architecture §4) | — |
| M-02 | All 12 migrations per `database-design.md` §4 checklist (incl. `invoice_counters`), named constraints/indexes, down scripts | Schema; NFR-06/07 at DB level | M-01 |
| M-03 | Docker: `docker-compose.yml` (db + api, healthchecks, named volume), server Dockerfile; migrate-on-boot | NFR-12 (NFR-DEPLOY-01) | M-01, M-02 |
| M-04 | Express skeleton: `app.js`, config/env validation, helmet/CORS/body-limit, request logger, `DomainError` taxonomy + `errorHandler`, `GET /health` | API §3 error model; FR-AUD-04 | M-03 |
| M-05 | Core middleware: `authenticate` (JWT + user re-check), `authorize(...roles)`, `validate(schema)`, `idempotency` | FR-AUTH-04/06; NFR-04; D-04/05/08 | M-04 |
| M-06 | `utils/money.js` + unit tests (integer cents, half-up per line, invariant `grand = subtotal + tax`) | D-09; NFR-07 | M-04 |
| M-07 | React skeleton: Vite app, router, `AuthContext`, `apiClient` (token attach + error normalize), login page | Frontend layers (architecture §4) | M-04 |
| M-08 | CI-style npm scripts: `dev`, `start`, `migrate`, `test` (node:test), `test:integration`, `test:frontend` (vitest), `test:e2e`, `lint` | NFR-10/11 wiring | M-01…M-07 |
| **Exit criteria** | `docker compose up --build` healthy; `/health` 200; migrations up/down/up pass; money unit tests pass; empty-route 404 contract passes | | |

### Phase 3 — Backend Domain (est. 6–9 days), vertical slices with tests written alongside
| ID | Task | Delivers |
|---|---|---|
| B-01 | Auth + users module (login, me, create, list, status) + AuditService | FR-AUTH-01…07, FR-AUD-01 |
| B-02 | Products module (CRUD, soft delete, search/pagination) | FR-CAT-01…05, FR-CAT-08 |
| B-03 | Inventory module (adjustments + movements ledger) | FR-CAT-06/07 |
| B-04 | Cart module (get/add/update/remove/empty) | FR-CART-01…05 |
| B-05 | Order creation: transaction, `FOR UPDATE` locks, pricing snapshot, idempotency integration | FR-ORD-01…06 |
| B-06 | Order lifecycle: confirm/fulfill/cancel state machine, stock release, invoice generation + numbering | FR-ORD-07…11, FR-INV-01…05 |
| B-07 | Audit query endpoint + idempotency cleanup job | FR-AUD-02/03/05 |
| B-08 | Integration suites covering every AC marked `Int`; injection suite (NFR-SEC-01); concurrency/load scripts (AC-ORD-05, NFR-PERF-01) | Evidence for §2 traceability |

### Phase 4 — Frontend Features (est. 5–7 days)
| ID | Task |
|---|---|
| F-01 | Catalog pages (list/search/detail with stock display) |
| F-02 | Cart page + flows (server-authoritative totals, stock warnings) |
| F-03 | Customer orders pages (list/detail/cancel with idempotent submit on checkout) |
| F-04 | Staff console: order queue (confirm/fulfill), inventory adjustments, invoice list/detail |
| F-05 | Admin: users, products CRUD, audit log viewer |
| F-06 | Vitest/RTL component tests; role-based navigation guards (cosmetic per D-05) |

### Phase 5 — E2E, Hardening & Pilot (est. 3–5 days)
| ID | Task |
|---|---|
| Q-01 | Playwright: buyer happy path + staff path + cancellation path (SC-05) |
| Q-02 | Security pass: rate limits, header audit, secret scan (NFR-SEC-02), log-leak grep (AC-AUD-02) |
| Q-03 | Load run vs NFR-05 targets; record measured numbers (or document "not measured" honestly) |
| Q-04 | Backup/restore procedure doc + drill (NFR-14) |
| Q-05 | Pilot walkthrough with ≥1 real distributor user; record SC-06 evidence (date/participants) or mark not-performed |

## 2. Requirements → tests traceability table

> **Status note (superseded by delivery).** The `Status` column below is the **original Phase-1
> planning baseline** and still reads `planned` for many rows that have since been built and
> verified. Do **not** trust those cells as current — read the authoritative **§5 Delivered
> status** checklist (updated after the Phase 15 acceptance audit) for what is actually done.
> This table is retained unmodified as a historical planning artifact.

Verification types: U = unit, I = integration, L = load, E = E2E (Playwright), F = frontend test, M = manual. Every Must-level requirement has at least one planned automated test; **status column is filled during Phases 3–5 — all rows start as `planned`**.

| Requirement | Acceptance criterion | Planned test (name) | Type | Status |
|---|---|---|---|---|
| FR-AUTH-01 | AC-AUTH-01 | `auth.test.js › login success returns JWT` | I | planned |
| FR-AUTH-02 | AC-AUTH-02 | `auth.test.js › login uniform 401` | I | planned |
| FR-AUTH-03 | AC-AUTH-03 | `auth.test.js › bcrypt hash stored`; log grep | I, M | planned |
| FR-AUTH-04 | AC-AUTH-04 | `middleware.test.js › missing/expired/badsig → 401` | I | planned |
| FR-AUTH-05 | AC-AUTH-05 | `users.test.js › create + duplicate email` | I | planned |
| FR-AUTH-06 | AC-AUTH-06 | `users.test.js › deactivation blocks old token` | I | planned |
| FR-AUTH-07 | AC-AUTH-01/04 | `auth.test.js › me returns profile` | I | planned |
| FR-CAT-01 | AC-CAT-01/02 | `catalog-unit/catalog-http.test.js › create + Zod validation` | I, U | **as-built (Phase 5)** |
| FR-CAT-02 | AC-CAT-06 | `catalog-http.test.js › PATCH is_active=false keeps row (soft archive)` | I | **as-built (Phase 5)** |
| FR-CAT-03 | AC-CAT-03 | `catalog-http.test.js › duplicate SKU → 409` | I | **as-built (Phase 5)** |
| FR-CAT-04 | AC-CAT-07 | `catalog-unit/http.test.js › pagination + search + sort (whitelist)` | I, U | **as-built (Phase 5)** |
| FR-CAT-05 | AC-CAT-01 | `catalog-http.test.js › detail by id; GET /api/inventory/low-stock` | I | **as-built (Phase 5)** |
| FR-CAT-06 | AC-CAT-04 | `catalog-http.test.js › adjustment writes movement+audit in one txn` | I | **as-built (Phase 5)** |
| FR-CAT-07 | AC-CAT-05 | `catalog-http.test.js › negative clamp → 409 INSUFFICIENT_STOCK` | I | **as-built (Phase 5)** |
| FR-CAT-08 | AC-CAT-06 | `catalog-http.test.js › inactive product hidden (404)`; `cart-http.test.js › add inactive product → 404 PRODUCT_NOT_FOUND` | I | **as-built (Phase 6)** |
| FR-CART-01 | AC-CART-01 | `cart-http.test.js › upsert merge increases qty, single DB row` | I | **as-built (Phase 6)** |
| FR-CART-02 | AC-CART-04 | `cart-unit.test.js › cartQuantity (0/-1/1.5/1001)`; `cart-http.test.js › qty validation → 400, inactive → 404` | I, U | **as-built (Phase 6)** |
| FR-CART-03 | AC-CART-02 | `cart-unit.test.js › money fixture 59.97/4.50/64.47`; `cart-http.test.js › server-side totals, client price rejected` | U, I | **as-built (Phase 6)** |
| FR-CART-04 | AC-CART-03 | `cart-http.test.js › over-stock 409 reserves nothing; stock_warning after admin reduces stock` | I | **as-built (Phase 6)** |
| FR-CART-05 | AC-ORD-01 | `cart-http.test.js › DELETE /api/cart empties (204)`; `order-http.test.js › placing a cart order empties it` | I | **as-built (Phase 7 — cart auto-emptied inside the order txn)** |
| FR-CART-05 (ownership) | AC-CART-05 | `cart-http.test.js › cross-customer isolation + persistence across sessions` | I | **as-built (Phase 6)** |
| FR-ORD-01 | AC-ORD-01/03/08 | `order-http.test.js › cart order server-priced + reserves + empties cart`; `› empty cart 422 EMPTY_CART` | I | **as-built (Phase 7)** |
| FR-ORD-02 | AC-ORD-01/02, AC-ORD-05 | `order-http.test.js › shortfall rolls back whole order, stock unchanged`; `› 20 concurrent buyers for 5 units (5 win, 15 get 409, never negative)` | I | **as-built (Phase 7 — real-DB concurrency, no separate load harness needed)** |
| FR-ORD-03 | AC-ORD-02 | `order-http.test.js › INSUFFICIENT_STOCK lists offenders with requested/available` | I | **as-built (Phase 7)** |
| FR-ORD-04 | AC-ORD-06 | `order-http.test.js › snapshot immune to later catalog price/name edit` | I | **as-built (Phase 7)** |
| FR-ORD-05 | AC-ORD-01, NFR-07 | `order-unit.test.js › money fixture`; `order-http.test.js › 19.99×2 @7.5 → 39.98/3.00/42.98, client price rejected` | I, U | **as-built (Phase 7)** |
| FR-ORD-06 | AC-ORD-04/07 | `order-http.test.js › same key replays 200 idempotent, stock reserved once; different body → 409 IDEMPOTENCY_CONFLICT; staggered double-submit → one order` | I | **as-built (Phase 7)** |
| FR-ORD-07 | AC-LIF-01/03/06 | `order-unit.test.js › lifecycle matrix (edges, no skip/backward, terminals)`; `order-http.test.js › legal chain pending→…→delivered` | I, U | **as-built (Phase 7)** |
| FR-ORD-08 | AC-LIF-04 | `order-http.test.js › cancel releases reservation once; re-cancel and post-ship cancel → 409` | I | **as-built (Phase 7)** |
| FR-ORD-09 | AC-LIF-01 | `order-http.test.js › PATCH /:id/status is staff-only (customer 403); ship consumes stock once` | I | **as-built (Phase 7 lifecycle + ship-consume; invoice-on-ship generation completed Phase 8, D-25)** |
| FR-ORD-10 | AC-LIF-02 | `order-http.test.js › invalid transitions → 409 INVALID_STATE_TRANSITION` | I | **as-built (Phase 7)** |
| FR-ORD-11 | AC-LIF-05 | `order-http.test.js › cross-customer read/items/cancel → 404 (no existence leak)` | I | **as-built (Phase 7)** |
| FR-INV-01 | AC-INV-01 | `invoice-http.test.js › no invoice until ship, then atomic; totals match order snapshot; immune to later price edits` | I | **as-built (Phase 8)** |
| FR-INV-02 | AC-INV-02 | `invoice-unit.test.js › formatInvoiceNumber INV-YYYY-NNNNNN`; `invoice-http.test.js › consecutive ships get strictly increasing yearly numbers` | I | **as-built (Phase 8)** |
| FR-INV-03 | AC-INV-01 | `db-integration › invoice totals CHECK subtotal+tax=grand`; `invoice-http.test.js › S+T=G on the issued invoice` | I | **as-built (Phase 8)** |
| FR-INV-04 | AC-INV-04 | `invoice-http.test.js › customer sees only own invoices (foreign → 404); staff sees all; customer cannot void` | I | **as-built (Phase 8)** |
| FR-INV-05 | AC-INV-03 | `invoice-http.test.js › second invoice for the same order rejected by UNIQUE order_id (idempotent)` | I | **as-built (Phase 8)** |
| FR-AUD-01 | AC-AUD-01 | `audit-http.test.js › completeness matrix` — product/inventory/order lifecycle (reserve→consume/release)/invoice/user edits + failed logins each emit their txn row | I | **as-built (Phase 9, D-26)** |
| FR-AUD-02 | AC-AUD-03 | `audit-http.test.js › trail is ADMIN-only & READ-ONLY (no mutation route)`; `db-integration › audit_logs append-only trigger` | I | **as-built (Phase 9)** |
| FR-AUD-03 | AC-AUD-03 | `audit-http.test.js › admin filters + pagination`; `report-http.test.js › dashboard ADMIN-only / order-summary+low-stock staff-only / customer refused`; `user-http.test.js › directory ADMIN-only` | I | **as-built (Phase 9)** |
| FR-AUD-04 | NFR-DEPLOY-01 | `health.test.js`; compose script | I, M | planned |
| FR-AUD-05 | AC-AUD-02 | `audit-unit.test.js` + `audit-http.test.js › details never carry password/JWT/PII` (allow-list JSONB only) | I, M/CI | **as-built (Phase 9)** |
| NFR-01 | AC-AUTH-03 | response-shape assertions + grep | I, M | planned |
| NFR-02 | NFR-SEC-01 | `security/injection.test.js` suite | I | planned |
| NFR-03 | NFR-SEC-02 | secret-scan step | M/CI | planned |
| NFR-04 | AC-AUTH-07, AC-CART-05, AC-LIF-05, AC-AUD-03 | per-group forbidden-role tests | I | planned |
| NFR-05 | NFR-PERF-01 | `scripts/load/perf-run.js` (20 vU closed-loop, seeded scale) | L | **measured PASS** (reads p95 118 ms, order p95 501 ms) |
| NFR-06 | AC-ORD-02 | rollback test + ledger reconciliation | I | planned |
| NFR-07 | AC-CART-02, D-09 set | `cart-unit.test.js › money` property + fixture | U | **as-built (Phase 6)** |
| NFR-08 | NFR-USE-01 | walkthrough checklist + screenshots | M | planned |
| NFR-09 | — | Playwright runs on Chromium desktop project | E | planned |
| NFR-10 | — | ESLint gate + file-size review in PR checklist | M/CI | planned |
| NFR-11 | NFR-TEST-01 | coverage command in phase report | CI | planned |
| NFR-12 | NFR-DEPLOY-01 | fresh-clone compose script | M | planned |
| NFR-13 | AC-AUD-01 | reconstruct-order drill from audit+snapshots | I, M | planned |
| NFR-14 | NFR-DEPLOY-01 (persistence step) | down/up data-preservation check + dump/restore doc | M | planned |
| SC-01…07 | §9 release definition | phase report aggregates above evidence | — | planned |
| E2E flows | SC-05 | `e2e/buyer.spec.js`, `e2e/staff.spec.js` (Phase 5 Q-01) | E | planned |
| UI core | NFR-08 | `client/src/test/*.test.jsx` (Phase 4 F-06) | F | planned |

Coverage check: every FR and NFR row above has ≥1 planned verification; every AC ID in `acceptance-criteria.md` appears in the table (AC-AUTH-01…07, AC-CAT-01…07, AC-CART-01…05, AC-ORD-01…08, AC-LIF-01…06, AC-INV-01…04, AC-AUD-01…03, NFR-SEC/PERF/DEPLOY/TEST/USE).

## 3. Milestones & sequencing rules

1. **Walking skeleton first** (end of Phase 2): health endpoint + login + one product listed in the SPA proves every layer end-to-end before feature breadth starts.
2. **Backend before frontend per slice**, tests in the same PR as code (no "test later" debt; NFR-11 measured each phase).
3. **Order creation (B-05) is the highest-risk module** — its concurrency tests (AC-ORD-05) gate the start of Phase 4.
4. Docs update in the same PR as any behavior change (release-definition item 5 in `acceptance-criteria.md`).

## 4. Definition of done per feature PR

Code layered per `architecture.md` §4 · Zod validation · RBAC declared · happy + sad + forbidden-role tests · audit write where FR-AUD-01 applies · lint clean · traceability row status updated with test name · no secrets/PII in logs.

## 5. Delivered status (implementation checklist — updated after Phase 15 acceptance audit, commit cf9adcc, v1.0.0)

Source of truth for every "verified" below is [`acceptance-report.md`](acceptance-report.md) and
[`test-results.md`](test-results.md) §8 — each was re-run live (backend 228/228, frontend 74/74,
E2E 17/17, deploy smoke 9/9, clean-DB migrate 18/14 + idempotent seed, compose persistence).

### 5.1 Completed & verified
| Group | IDs | Evidence tier |
|---|---|---|
| Auth & users | FR-AUTH-01…07, AC-AUTH-01…07 | Int + E2E + login/deploy smoke |
| Catalog & inventory | FR-CAT-01…08, AC-CAT-01…07 | Int + Unit + screenshots |
| Cart | FR-CART-01…05, AC-CART-01…05 | Int + Unit |
| Orders (create/stock/idempotency) | FR-ORD-01…06, AC-ORD-01…08 | Int (incl. 20-way oversell) |
| Orders (lifecycle) | FR-ORD-07…11, AC-LIF-01…06 | Int + E2E |
| Invoices | FR-INV-01…05, AC-INV-01…04 | Int |
| Audit | FR-AUD-01/02/03/05, AC-AUD-01…03 | Int + Unit + grep |
| Health endpoint | FR-AUD-04, NFR-DEPLOY-01 | deploy smoke + compose |
| Security NFRs | NFR-01/02/03/04, NFR-SEC-01/02 | Int injection suite + git secret scan |
| Reliability/correctness | NFR-06/07/13 | Int rollback + money fixtures + audit reconstruct |
| Maintainability/deployability | NFR-10/11/12/14 | ESLint clean + coverage recorded + compose up/down persistence |
| E2E + UI | SC-01…05, SC-05, UI core (F-06) | Playwright 17/17 + Vitest 74/74 |

### 5.2 Incomplete — deliberately out of scope for v1 (see `requirements.md` §3.2, `future-roadmap.md`)
Payments/settlement, shipping & carrier tracking, multi-warehouse/batch inventory, per-customer
pricing & discounts & credit limits, multi-jurisdiction tax, purchase orders/procurement, report
CSV/BI export, email invoice delivery, self-service password reset, localization/theming/native
apps, and **multi-tenancy** (C-10 fixes single-tenant). None are defects; each is a scoped v1
boundary with a sized roadmap entry.

### 5.3 Broken
**None found.** The Phase 15 independent re-run produced no critical or high defect; build, lint,
format, and all three test tiers exited 0 on the committed tree.

### 5.4 Unverified / not measured (honest — never reported as passing)
| Item | Status | Blocking? |
|---|---|---|
| NFR-05 / SC-07 / NFR-PERF-01 — p95 load at 20 vU on 500-product scale | ✅ **Measured PASS** (20-vU benchmark: reads p95 118 ms ≤ 500, order p95 501 ms ≤ 1500, 5xx 0 %). Evidence `evidence/test-reports/perf-load.md`. Dev-laptop datapoint, not production capacity | — |
| SC-06 / Q-05 — pilot usability ≤10 min with real users | ➖ **Not performed** (no pilot users) | No |
| NFR-08 / NFR-USE-01 — ≤5 UI-step formal count | ⚠️ Flows verified E2E; step count not measured | No (Should) |
| NFR-09 — Chrome **and** Edge ≥1280px | ⚠️ E2E ran **Chromium only** | No |
| 500-product / 200-customer perf seed set (A-07) | ✅ Generated on demand in the isolated benchmark DB via `npm run perf:seed` (dev/test DBs untouched) | No |

### 5.5 Candidate "next phase" options (all are scope decisions — require explicit approval)
A. **Load benchmark + perf seed** (roadmap #6) — **DONE**: retired NFR-05/SC-07 "not measured" via `backend/scripts/load/` (`npm run perf`), measured PASS on a dev laptop. B. **Cross-browser E2E** (Edge/Firefox, containerised) — close NFR-09. C. **Operational hardening** (external TLS, Redis rate-limit + token revocation, CI, managed secrets). D. A **business feature** (payments / per-customer pricing / multi-warehouse / self-service password reset / report export). Remaining options are mutually independent; the released v1.0.0 remains valid whichever is chosen.
