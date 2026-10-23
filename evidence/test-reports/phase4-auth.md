# Phase 4 — Authentication & RBAC: test evidence

Date: 2026-10-21. Environment: Windows, Node 24, PostgreSQL 16.15 (Docker, host port
5433), backend CommonJS, `NODE_ENV=test` for suites / `development` for the live smoke.

## Checks EXECUTED and PASSED (real output, this session)

### 1. Unit suite — `npm --prefix backend test` → **29 pass / 0 fail**

Raw: `phase4-backend-unit.txt` (app + auth). Covers:

| Area | Verified behaviours |
|---|---|
| Zod validators | email format + lowercase normalization; password ≥ 10 chars with letter+digit; blank name rejected; **strict schemas reject `role`/unknown fields** (role-injection attempts 400); validation details never echo the submitted password |
| JWT token service | HS256 pinned; iss/aud/typ claims present; malformed / expired / wrong-signature / **wrong-iss / wrong-aud / alg:none** tokens all rejected (null, never throw); **refresh envelope can never act as a bearer access token**; raw refresh secret only ever exposed via its SHA-256 hash (jti); Bearer parsing strict |
| Helpers | `toPublicUser` strips every password field; `ttlMs` parses s/m/h/d notation |
| RBAC middleware | `authorize()` allow/deny matrix (403 FORBIDDEN, 401 UNAUTHENTICATED, invalid role list throws at wiring time); `requireOwnership` — owner 200, stranger 403, missing resource 404 (no existence leak), admin bypass only when explicitly enabled; `requireSelf` |
| Existing HTTP foundation | 10 Phase-2/3 tests still pass (health incl. `db.state`, 404 envelope, INVALID_JSON, 413, helmet headers) |

### 2. Database + auth integration — `npm run test:integration` → **36 pass / 0 fail**

Raw: `phase4-integration-raw.txt` (20 Phase-3 schema tests + **16 new auth tests**),
executed against the isolated `b2b_oms_test` database only (opt-in gate
`B2B_RUN_DB_TESTS=1`; plain `npm test` skips it). New auth coverage:

- Register creates **customer only**; bcrypt hash (`$2b$12$…`) stored, never plaintext;
  default cart created atomically with the user
- Register with `role: ADMIN|admin|ORDER_MANAGER|agent` → **400** every time
- Duplicate email (incl. different case) → **409 EMAIL_TAKEN**; invalid input → 400
  without echoing the password
- Login sets `HttpOnly; SameSite=Strict; Path=/api/auth` cookie; refresh token never in
  the body; wrong password and unknown email return the **identical** 401 message
- Disabled account: login → **403 ACCOUNT_DISABLED**; still-valid access token → **401**
  after deactivation (middleware re-loads the user)
- Refresh rotation issues a new cookie; **reuse of a spent token → 401 TOKEN_REUSED and
  revokes the whole family** (successor token dies too); logout clears the cookie and
  kills refresh afterwards; garbage/missing cookies → 401 INVALID_REFRESH_TOKEN
- `GET /api/auth/me`: 200 with hash-free profile; missing/malformed bearer → 401; forged
  signature, expired, `alg:none`, and **refresh-type** bearer tokens all rejected
- RBAC via real middleware composition (probe router): customer 403 / agent 403 /
  admin 200 on admin route; staff route admits agent+admin; anonymous 401
- Cross-user data protection: self-scoped endpoint always addresses the caller;
  ownership-guarded route → stranger 403, owner 200, anonymous 401
- **Rate limiting**: 12 sequential wrong logins in one bucket → **429 RATE_LIMITED**
  with `RateLimit-*` + `Retry-After` headers (enforced via `B2B_ENFORCE_RATE_LIMIT=1`,
  per-test buckets via X-Test-Bucket so other tests are unaffected)
- Schema tests updated to **13 tables**; reversibility (`down --all` → `up`) still passes
  with the new `refresh_tokens` table

### 3. Live smoke vs the dev server — `GET/POST` on http://localhost:4000 → **ALL 15 EXPECTED STATUSES MATCH**

Raw: `phase4-auth-smoke.json` (script kept as `phase4-auth-smoke.script.txt`):
200 health → 201 register(customer) → 400 register(ADMIN role) → 409 duplicate →
200 login → 401 wrong password → 200 me → 401 no token → 401 malformed → 200 refresh
rotate → 401 **TOKEN_REUSED** (spent cookie) → 401 successor dead after family revoke →
200 logout → 401 refresh after logout → 200 seeded **admin** login (hash from Phase-3
seed verified against the new bcrypt compare path).

### 4. Quality gates

- `npm test` (aggregate): backend **29/29 pass**, frontend **2/2 pass**, exit 0
- `npm run lint`: **0 errors** (backend + frontend)
- `npm run format:check`: **all files formatted**
- Dev database migrated: 13/13 (`refresh_tokens` applied), `npm run db:health` →
  `schemaComplete: true`

## Fixes made during this phase (found by real runs)

1. `jwt.sign` rejects the `algorithms` option (verify-only) → sign/verify options split.
2. Integration auth suite initially starved on the shared IP rate bucket → test-only
   `X-Test-Bucket` key partitioning (production still keys on client IP).
3. `express-rate-limit` v8 validation requires `ipKeyGenerator(req.ip)` for IPv6 safety
   → adopted (a raw `req.ip` keyGenerator throws ERR_ERL_KEY_GEN_IPV6 on boot).
4. `register()` referenced a bare `accessToken` instead of `tokens.accessToken` → fixed.
5. Rate-limit header assertion used `ratelimit` (draft-6 combined) → v8 sends
   `ratelimit-limit/remaining/reset` → corrected.
6. Register inserted the default cart with column `user_id`; the schema uses
   `carts.customer_id` → fixed (caught by integration test).
7. **Test-isolation race (found during final re-verification).** The raw integration
   log showed an intermittent `request.failed POST /api/auth/register status 500` even
   though every assertion passed. Root cause: `node --test` runs test **files in
   parallel** by default, and both `db-integration.test.js` and `auth-http.test.js`
   share the single `b2b_oms_test` database — while the schema suite's `down --all,
   then up` reversibility test drops every table, an auth `register` INSERT can land
   against a just-dropped `users`/`carts` table (→ 500) or collide on node-pg-migrate's
   advisory lock (→ `Another migration is already running`, cancelling the whole auth
   suite). Fixed in `scripts/db/run-integration-tests.js` by adding
   `--test-concurrency=1` so the two files run one at a time. This is a **test-harness**
   isolation defect, not a production-code defect. Re-ran the suite **4× consecutively**
   after the fix: **36/36 pass, 0 cancelled, 0 spurious 500s** each time.

## NOT executed / remain unverified (honest list)

- **Full `docker compose up --build`** stack with the new code (compose itself unchanged;
  backend image will include the new files via existing COPY rules).
- **Frontend** login UI — out of scope for this phase's instruction (API only); no SPA
  changes were made, frontend tests still pass unchanged.
- Refresh-token **expiry** (7 d) not waited on in real time; proven only via
  short-TTL signing logic and the expired-JWT unit test.
- `purgeExpired()` cleanup is implemented + tested at repository level only — **not yet
  scheduled** by any cron/job runner (same deferred posture as the Phase-3 idempotency
  pruning; wiring is a Phase 5 ops concern).
- bcrypt cost 12 on constrained hardware (only ~250 ms locally) not benchmarked elsewhere.
- No load/soak testing of the auth path.
