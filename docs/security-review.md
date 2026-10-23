# Security Review — B2B Order Management Platform

**Scope:** the security controls actually implemented in this codebase, how each is verified
by the automated suite / documented configuration, and the **residual risks that remain**.
This is a self-review, **not** a penetration test — no independent red-team engagement was
performed. Evidence links: [`test-results.md`](test-results.md),
[`requirements-traceability.md`](requirements-traceability.md),
[`phase13-docker-deployment.md`](../evidence/test-reports/phase13-docker-deployment.md),
decisions [D-19](decision-log.md) (auth) and [D-27](decision-log.md) (dependency posture).

Threat model assumption: a **single-tenant** distributor deployment (C-10/A-01) with
authenticated, semi-trusted staff (admin/agent) and external customers. The primary assets
are order/inventory correctness (no oversell), financial totals integrity, and access
control.

---

## 1. Authentication

| Control | Implementation | Verification |
|---|---|---|
| Password hashing | `bcryptjs` cost **12** (`BCRYPT_ROUNDS`); only `password_hash` is stored | auth unit + integration (AC-AUTH-03) |
| Login issues short JWT | `jsonwebtoken`, HS256 **alg pinned**, `iss`/`aud`/`typ`/`exp` validated every request | `token.service.js`, integration (AC-AUTH-04) |
| Refresh-token rotation | opaque 256-bit secret stored **only as a SHA-256 hash** in `refresh_tokens`; each refresh revokes and re-issues within a *family* | integration auth/rotation suite |
| Reuse detection | a spent refresh token replayed → **entire family revoked**, `401 TOKEN_REUSED` | integration rotation tests |
| Constant-work on unknown user | bcrypt compare runs even for a non-existent email → no user enumeration | integration (uniform `401 INVALID_CREDENTIALS`) |
| Account disabled kills session | `authenticate` re-loads the user per request; `is_active=false` → rejected | integration + E2E "disabled account 403" |

**Token model (D-19):** access token lives **in SPA memory only** (never `localStorage`) and
is sent as `Authorization: Bearer`; the refresh token is an **`HttpOnly; SameSite=Strict;
Path=/api/auth; Secure`** cookie. A leaked access token self-heals in 15 min.
**Verified live:** Phase 13 smoke asserted the refresh cookie carries
`HttpOnly; Secure; SameSite=Strict`.

## 2. Authorization (RBAC)

- Server-side `authorize('ADMIN','ORDER_MANAGER',…)` middleware guards **every** protected
  endpoint (NFR-04); frontend route guards are explicitly **convenience only**.
- Row-level ownership enforced by `requireSelf` (identity from the token, never the body) and
  `requireOwnership` (foreign resource → `404`, not `403`, so existence isn't leaked).
- Public surface is deliberately narrow: `POST /api/auth/register|login|refresh|logout`,
  `GET /api/health` `/health`, and read-only active-catalog reads (`optionalAuthenticate`).
  **No `POST /api/users`** exists — registration can only mint a **CUSTOMER**; admin/agent
  accounts come from the controlled dev seed only.
- Verified: per-role forbidden cases across the 133-test integration suite and the 7 E2E
  negative/adversarial paths (anon `401`, customer staff-write `403`, agent product-write `403`,
  cross-customer order/invoice `404`).

## 3. Input validation & injection defence

- **Zod strict schemas** at every route boundary — unknown fields (e.g. `role` on register)
  are a hard `400`; quantities, prices, tax rates, enum states all range-checked.
- **100 % parameterized SQL** in the repository layer — no string interpolation of values.
  The `NFR-SEC-01` hostile-input replay (`' OR 1=1 --`, `"); DROP TABLE orders;--`, oversized
  strings) is exercised in the integration suite with schema/row-count invariants asserted.
- Money handled with **decimal-safe integer/`NUMERIC`** arithmetic (`utils/money.js`) — no
  float rounding abuse of totals.

## 4. Data protection & secrets

| Area | Control |
|---|---|
| Secrets at rest in code | **None.** Only `.env.example` placeholders are committed; real `.env` files are git-ignored |
| Secrets at runtime | supplied via environment; `backend/src/config/env.js` **refuses to boot** in `production` on a missing/<32-char/dev-default JWT secret or `COOKIE_SECURE=false` (verified live in Phase 13) |
| Secrets in images | no Dockerfile `COPY`s `.env*`; both `.dockerignore`s exclude them; Phase 13 image audit confirmed **`.env count: 0`** in both images |
| Secret interpolation | Compose `${VAR:?}` fails fast if `POSTGRES_PASSWORD`/`JWT_*` are absent |
| Logging | `requestLogger.js` redacts `password|token|secret|authorization|cookie|email…`; AC-AUD-02 grep confirms no test password/JWT ever reaches a log or audit row |
| Passwords/PII in responses | never returned; audit `details` exclude secrets (FR-AUD-05) |

## 5. Transport, headers & browser hardening

- **Same-origin by design**: nginx proxies `/api` to `backend:4000`, so cookies are
  first-party and CORS stays locked down (`CORS_ORIGINS` empty by default, never `*`).
- Security headers on the SPA edge: `X-Content-Type-Options: nosniff`, `X-Frame-Options`
  (nginx); the API uses **`helmet`**.
- **`Secure` cookies + HTTPS:** containers serve plain **HTTP**; `COOKIE_SECURE=true` is
  mandatory in production, but **TLS termination is not provided in-container** (see §7).
  `X-Forwarded-Proto` is forwarded for an upstream proxy to set.

## 6. Rate limiting & abuse

- Per-IP limits on sensitive endpoints: login/refresh `10`/15 min, register `5`/15 min →
  `429 RATE_LIMITED` with `RateLimit-*`/`Retry-After` (env-tunable).
- **Idempotency** on `POST /api/orders` (required `Idempotency-Key`, 24 h retention) prevents
  duplicate-submission double-decrement — a business-integrity control that also blunts replay.
- **Oversell guard**: row-level `SELECT … FOR UPDATE` + DB `CHECK (physical-reserved>=0)` makes
  negative stock impossible; proven by the 20-way concurrency integration test (SC-02).

## 7. Deployment & supply-chain security

- Non-root API container (`node`, uid 1000); PostgreSQL unpublished in the production-shaped
  compose file (internal `db:5432` only); readiness-gated, single migration runner (Phase 13).
- Dependency posture (**D-27**, re-checked in Phase 13): frontend **production** bundle
  (`--omit=dev`) audits **0 vulnerabilities**; root **0**; e2e **0**; backend **2 high** both in
  the `glob` CLI `-c/--cmd` path pulled in by `node-pg-migrate` — **not reachable** the way this
  app runs migrations (controlled `npm run db:migrate`, no attacker input), fix requires a
  D-17-conflicting ESM major upgrade. Accepted & tracked, not ignored.
- The Phase 13 container test **surfaced and fixed a real production defect**: `bcryptjs`
  (required at runtime) had been misdeclared a devDependency and was missing from the
  `--omit=dev` image — now corrected.

---

## 8. Residual risks & limitations (honest)

| # | Residual risk | Why it remains | Realistic mitigation |
|---|---|---|---|
| R-1 | **No TLS terminated by the app itself** | Compose ships plain HTTP for the demo | Put the SPA/API behind an LB or Caddy/Traefik/nginx with real certificates; keep `COOKIE_SECURE=true` |
| R-2 | **Secrets are plain environment variables** | no vault/HSM/KMS in scope | Use a managed secret store + rotation; rotating a JWT secret today invalidates all live tokens |
| R-3 | **In-memory access token** | XSS can still act within the ≤15 min window (no `localStorage`, no server blocklist) | Short TTL is the current defence; a token blocklist needs shared state (deferred) |
| R-4 | **In-process rate limiting** | per-instance memory store; scaling multiplies effective limits | Move to a Redis-backed store before horizontal scaling |
| R-5 | **No multi-tenant isolation** | single-tenant by requirement (C-10) | Adding a tenant requires row-level security / scoping across every query |
| R-6 | **No MFA / password policy / lockout** | out of v1 scope | Add TOTP + complexity/lockout for staff accounts |
| R-7 | **`nginx:1.27-alpine` runs a root master** | standard image; workers are unprivileged | switch to `nginxinc/nginx-unprivileged` for full rootless |
| R-8 | **Base images tag-pinned, not digest-pinned** | convenience | digest-pin (`@sha256:…`) for supply-chain reproducibility |
| R-9 | **No automated security scan in CI** | no CI pipeline built (single-node scope) | add SAST/`gitleaks`/`npm audit` gates to CI |
| R-10 | **Latency/DoS resilience not load-tested** | no scripted load run | see SC-07/NFR-05 — **not measured**; benchmark before production |
| R-11 | **Backend `glob` advisory accepted, not patched** | breaking ESM upgrade conflicts with D-17 | revisit on a non-breaking patch (D-27 trigger) |
| R-12 | **Dev seed passwords are known** (`Passw0rd!`) | fixtures for demo/E2E only | never seed a real environment; change all credentials |

## 9. What was **not** done

- No external penetration test or dynamic security scan was executed.
- No runtime performance/latency security benchmark under load (R-10).
- No formal threat-modeling workshop with a security reviewer; the model above is a
  developer self-review.

Controls marked verified are backed by tests that actually ran (see `test-results.md`); items in
§8 are disclosed as un-mitigated rather than claimed secure.
