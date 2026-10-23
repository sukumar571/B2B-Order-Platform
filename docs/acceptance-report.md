# Final Acceptance Report — B2B Order Management Platform (Phase 15)

**Reviewer stance:** independent senior reviewer; nothing assumed correct from prior phases.
**Method:** every "Result" below comes from a command **executed on this working tree on
2026-10-23 (IST)** (Node v24.17.0, npm 11.13.0, Docker Engine 29.9.1 / Compose v5.6.0, Windows).
Requirements never exercised with a real command are marked **UNVERIFIED**, not "passed".
**Result legend:** ✅ Pass (executed, observed) · ⚠️ Pass-with-caveat · ⛔ Blocked/Fail ·
➖ Not measured (honest).

Environment note: the development stack PostgreSQL runs on host port **5433** (native Postgres
holds 5432 — D-17). All audit DB work used **isolated scratch databases/containers** and the
running dev DB was left untouched.

---

## A. Verification-by-command (the 19 requested checks)

| # | Requirement / area | Evidence | Test or verification | Result | Remaining issue |
|---|---|---|---|---|---|
| 1 | Frontend production build | `dist/index.html` + `assets/index-*.js` (256.75 kB) + css, "76 modules transformed", "built in 1.93s" | `npm run build:frontend` | ✅ | None |
| 2 | Backend startup + health endpoint | Compose boot → `GET /api/health` → `{"status":"ok","db":{"state":"up","latencyMs":1}}` via nginx proxy | `docker compose up -d` + `node scripts/deploy-smoke.js` (check 4) | ✅ | None |
| 3 | Migrations from a clean isolated DB | 18 migrations UP (…0001→…0018), **14 tables** (13 business + `pgmigrations`) in a freshly created `b2b_oms_audit` | `CREATE DATABASE b2b_oms_audit` → `node scripts/db/migrate.js up` → `information_schema` count | ✅ | Scratch DB dropped after test |
| 4 | Seed script behavior | "Seeded 4 users … and 6 products"; re-run → "Existing data found — seed skipped"; users=4/products=6/inventory=6; roles admin/agent/customer/**disabled(f)** | `node scripts/db/seed.js` ×2 + psql counts + `health-check` (`schemaComplete:true`, `appliedMigrations:18`) | ✅ | None |
| 5 | Registration, login, auth, role authorization | 228-test backend suite incl. auth HTTP (register/login/refresh-rotation/reuse-detection/rate-limit) + `POST /api/auth/login (admin)` 200 + anon `GET /api/cart`→401 + admin-only dashboard 200 | `npm run coverage:backend` + `deploy-smoke.js` + E2E journeys 1/3/10 | ✅ | None |
| 6 | Product CRUD + inventory operations | Catalog/inventory HTTP integration (201 create, `409 DUPLICATE_SKU`, PATCH, activate/deactivate, stock adjust + ledger/audit row) | `npm run coverage:backend` (catalog+inventory suites) | ✅ | None |
| 7 | Cart persistence & ownership | Cart HTTP: upsert-merge single row, server-priced totals, cross-customer isolation (foreign item → 404), persistence | integration (16 cart HTTP) + E2E journey 4 | ✅ | None |
| 8 | Transactional order placement | Order HTTP: reserve-on-create in one tx; short-failure → `409` + **full rollback** (no order, stock unchanged) | `npm run coverage:backend` (order HTTP) + E2E "atomic rollback" | ✅ | None |
| 9 | Concurrent inventory safety | 20-way last-unit race → exactly 5 succeed / 15 `409 INSUFFICIENT_STOCK`, never negative (SC-02 / AC-ORD-05) | DB integration 20-way concurrency test | ✅ | Proves correctness, **not** p95 timing (see D-#6) |
| 10 | Idempotent order submission | Same key/same user replays original `200 {idempotent:true}`, stock decremented once; mismatched body → `409 IDEMPOTENCY_CONFLICT`; missing key → `400` | integration (replay/conflict/missing-key) + E2E "duplicate request" | ✅ | None |
| 11 | Valid status transitions & cancellation | State machine: confirm→fulfil ok; fulfil-pending → `409 INVALID_STATE_TRANSITION`; cancel releases reserved stock atomically; terminal states refuse | integration (lifecycle) + E2E journey 7 + demo | ✅ | None |
| 12 | Invoice generation & ownership | Invoice appears only on fulfil, exactly once (`UNIQUE(order_id)`), `total = order total`, sequential `INV-YYYY-NNNNNN`; foreign invoice → 404; void staff-only | integration (10 invoice HTTP) + E2E journeys 7/8/10 | ✅ | None |
| 13 | Audit-log correctness & access | Completeness matrix (login/product/inventory/order/invoice/user events incl. `failure` rows), append-only (no mutation route), ADMIN-only reads | integration (audit HTTP) + unit (action registry exhaustive) | ✅ | None |
| 14 | Dashboard metric correctness | Aggregation on isolated window; order value **excludes cancelled, is not revenue**; agent view withholds audit feed; bad window → `400` | integration (report HTTP) + `deploy-smoke` dashboard 200 | ✅ | None |
| 15 | Frontend integration with real APIs | 10 real-browser journeys drive the live SPA against the live API + disposable DB (no mocks); 74/74 Vitest+RTL units | `npm run test:e2e` + `npm run coverage:frontend` | ✅ | None |
| 16 | Unit / integration / E2E tests | Backend **228/228** (96.34% lines), Frontend **74/74** (87.76%), E2E **17/17**; integration subset **133** within the 228 | `coverage:backend`, `coverage:frontend`, `test:e2e` (all this session, exit 0) | ✅ | None |
| 17 | Docker Compose startup & persistence | Ordered boot (db→one-shot migrate Exited 0→backend→frontend), only web port published, **9/9** smoke, `down`(keep volume)→`up` restored users=4/products=6/migrations=18 | `docker compose … up -d --build` + `deploy-smoke` + down/up counts | ✅ | Demo needs explicit `docker:seed` step |
| 18 | README setup instructions | Every `npm run …` in README maps to a real root `package.json` script; Docker quick-start reproduced exactly as documented | static cross-check + the successful compose run above | ✅ | None |
| 19 | No committed secrets / junk files | `.gitignore` ignores `.env*`,`node_modules`,`dist`,`coverage`,`playwright-report`,`test-results`,`backups/`; `git add -A --dry-run` = **336 files, zero secrets/dumps/artifacts**; secret grep clean; `.env.example` placeholders only | `git check-ignore` + `git add --dry-run` + grep | ✅ | 3 stale P13 volumes in Docker (L-1) |

---

## B. Must-have acceptance criteria (release-gating)

All **Must** ACs in `acceptance-criteria.md` are backed by an executed test in §A/§16. Summary of
the ones with a dedicated assertion:

| AC | Criterion | Verification | Result |
|---|---|---|---|
| AC-AUTH-01/02/03/04/05/06 | login/bad-creds/hash-only/reject-bad-token/dup-email/deactivate | Int (228-suite) | ✅ |
| AC-CAT-01..06 | product create/validation/dup-SKU/adjust+ledger/refuse-negative/inactive-hidden | Int + screenshots | ✅ |
| AC-CART-01/02/03/04 | merge-line/server-money-exact-to-cent/availability-warn/qty-validation | Int + Unit | ✅ |
| AC-ORD-01..07 | create+reserve/rollback/ignore-client-totals/idempotent/**20-way-oversell**/snapshot-immutable/missing-key | Int + Load(20-way correctness) | ✅ |
| AC-LIF-01..05 | confirm→fulfil→1invoice/refuse-skip/terminal-cancel-blocked/cancel-releases/foreign→404 | Int | ✅ |
| AC-INV-01/02/03 | invoice-total=order/sequential-number/DB-dup-rejected | Int | ✅ |
| AC-AUD-01/02 | one-row-per-event/secret-never-in-logs-or-audit | Int + grep | ✅ |
| NFR-SEC-01 | SQLi/hostile-input suite → validate-fail or literal, schema unchanged | Int (injection suite) | ✅ |
| NFR-SEC-02 | repo secret scan clean, only `.env.example` placeholders | Git/grep (§A.19) | ✅ |
| NFR-DEPLOY-01 | `compose up` → health ok ≤60s; migrations on empty volume; down/up preserves data | Compose run (§A.17) | ✅ |
| NFR-TEST-01 | fresh-tree suites all pass; backend order/inventory/pricing lines ≥80% | §16 (96.34% backend overall) | ✅ |

**Should / qualitative (honest status, not release-blocking):**

| AC | Status | Result |
|---|---|---|
| AC-AUTH-07, AC-CART-05, AC-CAT-07, AC-ORD-08, AC-LIF-06, AC-INV-04, AC-AUD-03 | Covered by the green suites | ✅ |
| NFR-PERF-01 / SC-07 | **20-vu p95 load test NOT run** (no load harness executed this audit); the 20-way test proves *correctness* only | ➖ Not measured |
| SC-06 | Pilot usability timing with real users **not performed** | ➖ Not measured |
| NFR-USE-01 | Flows run end-to-end; the "≤5 UI steps" count **not formally measured** | ➖ Not measured |
| NFR-09 | E2E ran **Chromium only**; Edge/Firefox not exercised | ⚠️ Caveat |

---

## C. Issue classification & actions

| ID | Priority | Issue | Action taken |
|---|---|---|---|
| C-1 | **Critical** | None found | — |
| H-1 | **High** | None found (all suites green, build/lint/format clean, no secrets, deploy+persist verified) | — |
| M-1 | Medium | All `package.json` versions still `0.1.0`, inconsistent with a v1.0.0 release tag | **FIXED**: bumped root/backend/frontend/e2e to `1.0.0` via `npm version --no-git-tag-version`; lockfiles aligned; `format:check` re-verified green |
| M-2 | Medium | Deploy smoke returns **6/8** if the demo stack is migrated but **not seeded** (login needs seed data) | By design (seed is `--profile tools`). After `docker:seed` → **9/9**. Documented; no code change |
| L-1 | Low | 3 stale Phase-13 audit volumes linger in Docker (`b2b_p13_clean_pgdata`, `_final_`, `_fresh_`) | Reported for manual `docker volume rm` (destructive data op left for operator approval) |
| L-2 | Low | E2E needs ports 4000/5173 free (`reuseExistingServer:false`, K-5) | Two stale dev-server node processes were stopped; suite then passed 17/17. Documented in README Troubleshooting |
| L-3 | Low | Frontend `LoginPage.jsx` (5.63%) / `UsersPage.jsx` (6.01%) unit coverage gaps | Accepted — covered by real browser journeys; disclosed in `limitations.md` §4 |

**Reruns after the only fix (M-1):** `npm run format:check` → exit 0; `package.json` version header
now reads `1.0.0`. The version change is metadata-only and does not affect the already-green build,
lint and all three test tiers (no application logic touched).

---

## D. Acceptance decision

- Every **Must** acceptance criterion is verified by an actually-executed command with recorded
  output. The two **Should**-tier quantitative items (NFR-PERF-01/SC-07 load, SC-06 pilot) and the
  NFR-USE-01 step count were **not measured** and are honestly reported as such — none is a
  release-blocking Must.
- No critical or high defect was found. One medium release-hygiene defect (version fields) was
  fixed and re-verified.
- **Therefore the acceptance criteria for a v1.0.0 functional release are met**, scoped as the
  single-tenant v1 described in `requirements.md` §3.1. **Recommend tag `v1.0.0`.**
- **Do NOT** claim measured performance, pilot usability, or business impact in the release notes —
  those were not measured (see `limitations.md`).
