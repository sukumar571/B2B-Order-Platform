# Phase 11 — Security & Dependency Audit: test evidence

Date: 2026-10-23. Environment: Windows, Node 24, PostgreSQL 16 (Docker, host port
**5433**), backend CommonJS/Express, frontend React 18 + Vite. `NODE_ENV=test` for the
unit/integration suites.

**Phase 11 made no functional or schema change.** Its purpose was to run a dependency
vulnerability audit across all three npm workspaces (root, backend, frontend), triage any
findings by *reachability* rather than raw severity, record the accepted/deferred risk as a
decision (**D-27**), and re-run every quality gate to prove the delivered Phases 1–10 tree is
still green and unregressed.

Every command below was **executed this session**; the raw console output is captured in this
folder as `phase11-*.txt`. No result here is extrapolated from an earlier run.

---

## 1. Quality gates

| Gate | Command | Result | Raw |
|---|---|---|---|
| Backend lint | `npm --prefix backend run lint` | **PASS** — 0 errors | `phase11-backend-lint.txt` |
| Backend unit | `npm --prefix backend test` | **PASS** — 95 tests / 95 pass / 0 fail | `phase11-backend-unit.txt` |
| Backend integration | `npm --prefix backend run test:integration` | **PASS** — 133 tests / 133 pass / 0 fail / 11 suites (isolated `b2b_oms_test` DB) | `phase11-integration-raw.txt` |
| Frontend lint | `npm --prefix frontend run lint` | **PASS** — 0 errors | `phase11-frontend-lint.txt` |
| Frontend unit | `npm --prefix frontend test` | **PASS** — 74 tests / 74 pass (8 test files) | `phase11-frontend-test.txt` |
| Frontend build | `npm --prefix frontend run build` | **PASS** — 76 modules transformed, built OK | `phase11-frontend-build.txt` |
| Format | `npm run format:check` | **PASS** — "All matched files use Prettier code style!" | `phase11-format-check.txt` |

The backend integration total rose to **133** from the 112 recorded in Phase 9 because Phase 10's
verification re-ran the whole cross-module surface (auth refresh-rotation, cart, orders, invoices,
audit, reports, admin users, security & edge cases, DB invariants, migration reversibility); this
phase re-executed the consolidated suite and confirmed **0 failures**.

---

## 2. `npm audit` results (executed this session)

| Workspace | Full tree | Production surface (`--omit=dev`) |
|---|---|---|
| root | **0 vulnerabilities** — `phase11-npm-audit-root.txt` | n/a (only `prettier`) |
| backend | **2 high** — `phase11-npm-audit-backend.txt` | 2 high — `phase11-npm-audit-backend-prod.txt` |
| frontend | **3 (1 moderate, 2 critical)** — `phase11-npm-audit-frontend.txt` | **0 vulnerabilities** — `phase11-npm-audit-frontend-prod.txt` |

### 2.1 Backend — 2 high

- **Package:** `glob 11.0.0–11.0.3` pulled in by `node-pg-migrate` (a direct dependency).
- **Advisory:** GHSA-5j98-mcp5-4vw2 — "glob CLI: Command injection via `-c`/`--cmd`
  executes matches with `shell:true`."
- **Reachability:** The application uses `node-pg-migrate` only through the controlled
  `npm run db:migrate` scripts (and the compose migrate-on-boot command), which never pass a
  `-c/--cmd` argument and never take attacker-controlled input. The vulnerable code path is
  therefore not reachable in any request.
- **Why not auto-fixed:** `npm audit fix --force` installs `node-pg-migrate@9`, which is
  **ESM-only** and would break the **D-17 CommonJS pin** for the whole backend. Breaking the
  architecture convention to silence an unreachable advisory is not justified.
- **Status:** **Accepted (documented in D-27)** with a re-review trigger — a non-breaking
  patch release, or any deployment where migration tooling could receive untrusted input.

### 2.2 Frontend — 3 (1 moderate, 2 critical), all test-only

- **Packages:** `@vitest/mocker <=4.1.11` (moderate — path traversal / arbitrary file read
  GHSA-82fw-gwwq-j7x9, code injection GHSA-qxg6-89mg-rqv8) and `tinypool <=2.1.1`
  (critical — prototype-pollution → RCE, GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr),
  both reached through `vitest`.
- **Reachability:** `vitest`, `@vitest/mocker` and `tinypool` are **devDependencies**. They run
  only inside the local test harness, are **never bundled into `dist/`**, and cannot be reached
  by a browser or the API. This is proven directly: `npm audit --omit=dev` on the frontend
  reports **0 vulnerabilities**.
- **Why not auto-fixed:** the only remediation is `vitest@5`, a **breaking major** with zero
  production benefit (nothing ships to end users from this dependency chain).
- **Status:** **Accepted** (test-tooling advisories; same re-review trigger).

### 2.3 Production-surface conclusion

The **runtime/production attack surface is clean**: the shipped browser bundle has
**0** known vulnerabilities (`--omit=dev`), the root workspace has **0**, and the backend's 2
high findings sit in a CLI code path the application never executes and are pinned by an
architecture decision (**D-17**). Full reasoning is recorded as **D-27** in
`docs/decision-log.md`.

---

## 3. Integration coverage re-confirmed this session

All Phase 3–10 suites were re-run against the isolated `b2b_oms_test` DB and are green in
`phase11-integration-raw.txt` (11 suites / 133 tests / 0 fail):

- **Audit trail over HTTP** — ADMIN-only endpoint, read-only (no write route), transactional
  lifecycle auditing, `LOGIN_FAILED`/`LOGIN_SUCCESS` outcome semantics, filters + pagination,
  malformed filters fail closed.
- **Authentication over HTTP** — CUSTOMER-only registration, `409 EMAIL_TAKEN`, rotating refresh
  with family-revocation on reuse, disabled-account rejection, rate limiting (`429`).
- **Shopping cart over HTTP** — customer-only self-scoped cart, server-side totals, upsert merge,
  over-stock `409` with no reservation, cross-customer isolation, audited mutations.
- **Catalog & inventory over HTTP** — public active-only listing, ADMIN writes, soft archive,
  staff inventory + low-stock, transactional `PATCH /api/inventory/:id` movement + audit.
- **PostgreSQL invariants** — full 13-table schema, FK/CHECK/UNIQUE enforcement, generated
  `available_quantity`, snapshot immutability, rollback atomicity, append-only `audit_logs`,
  `outcome` CHECK, invoice-counter + idempotency-claim rows.
- **Migration reversibility** — `down --all` removes every table; `up` restores the identical
  schema.
- **Invoices / Orders / Reports & dashboard / Security & edge cases / Administrative user
  management over HTTP** — the complete Phase 7–10 guarantees re-verified.

---

## 4. What Phase 11 did **not** change

- No application, schema, migration, route, or dependency version was modified.
- No test was rewritten; the existing suites were re-executed to prove the current tree is
  still green.
- `npm audit fix` / `fix --force` was deliberately **not** run (it would force the breaking,
  D-17-conflicting upgrades argued against in §2 and **D-27**).

## 5. Notes / limitations

- These findings reflect the public advisory database as of the audit date; a later
  `npm audit` may show new or since-patched items. The acceptance in **D-27** is explicitly
  conditional and is re-examined whenever the reachability premises change or a **non-breaking**
  fix becomes available.
- `express-rate-limit`'s in-memory store remains per-instance (acceptable at the documented
  A-02/A-08 scale, tracked under D-19), so horizontal-scaling rate limiting is still a
  post-pilot item and was not in Phase 11's scope.
