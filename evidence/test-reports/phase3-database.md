# Phase 3 — PostgreSQL Database Layer: Test & Verification Evidence

Executed Wednesday, 2026-10-21 on the development machine
(Windows, Node v24.17.0, npm 11.13.0, Docker 29.9.1, PostgreSQL 16.15 via
`postgres:16-alpine` container, published on host port **5433** because a
native `postgresql-x64-18` Windows service occupies 5432 on this machine).

## Checks that actually ran and PASSED

| # | Check | Command | Result | Raw evidence |
|---|-------|---------|--------|--------------|
| 1 | Migrations up (dev DB) | `npm run db:migrate` | PASS — 12/12 migrations applied | `phase3-migrate-dev.log.txt` (final no-op re-run) |
| 2 | Schema health check | `npm run db:health` | PASS — connected, server 16.15, `tablesFound: 12/12`, `schemaComplete: true`, `appliedMigrations: 12` | console output quoted in README §Phase 3 |
| 3 | Seed script | `npm run db:seed` | PASS — inserted 3 users + 6 products/inventory; re-run correctly SKIPPED ("Existing data found — seed skipped (nothing was changed)") | — |
| 4 | DB integration suite (isolated `b2b_oms_test`) | `npm run test:integration` | PASS — **20 tests, 0 failures** (connectivity, schema completeness, FK violations incl. RESTRICT history protection, all uniqueness rules, quantity/price/total CHECKs, generated-column read-only, NUMERIC(12,2) overflow bound, historical snapshots, transaction commit/rollback incl. audit pairing, oversell rejection via CHECK, append-only audit trigger, invoice counter upsert, idempotency claim/replay, migration `down --all` + `up` reversibility) | `phase3-integration-raw.txt` |
| 5 | HTTP + unit tests (no DB required) | `npm --prefix backend test` | PASS — 10/10 (health JSON now also asserts `db.state = "not_configured"` when no DB is configured) | `backend-test.txt` (Phase 2) superseded; current run quoted in README |
| 6 | Aggregate test suite (backend + frontend) | `npm test` | PASS — backend 10/10, frontend 2/2 | — |
| 7 | Lint (backend + frontend) | `npm run lint` | PASS — 0 errors | — |
| 8 | Formatting | `npm run format:check` | PASS — "All matched files use Prettier code style!" | — |
| 9 | Live health endpoint with DB UP | start `node src/server.js` + GET `/api/health` | PASS — HTTP 200 `{"status":"ok","db":{"state":"up","latencyMs":47,…}}` | `phase3-health-smoke.json` |
| 10 | Live degraded path | `docker compose stop db`, GET `/api/health` | PASS — HTTP **503** `{"status":"degraded",…,"db":{"state":"down"}}`; DB restarted afterwards, dev data verified intact (3 users / 6 products) | README §Phase 3 |

## Fixes made during verification (real failures found and corrected)

- `pgm.createCheckConstraint` does not exist in node-pg-migrate v7 → converted
  to `pgm.addConstraint(…, { check })`.
- v7 `generated: 'stored'` emits identity DDL → generated column written via
  explicit `pgm.sql(… GENERATED ALWAYS AS … STORED)`.
- v7 composite-index descriptor objects unsupported → plain column lists.
- v7 `createFunction(name, params, options, definition)` arity and
  `dropFunction(name, params, options)` arity corrected.
- node-pg-migrate v9 is ESM-only → pinned v7 (CommonJS) to keep the backend
  consistently CommonJS as mandated.
- Test expectations corrected against real PostgreSQL behavior: generated
  column writes raise SQLSTATE `428C9`; enum CHECK test needed a real row;
  invoice numbers must be unique across re-runs (counter-based).

## NOT executed / remaining unverified (honest list)

- `docker compose up --build` full stack bring-up (backend migrate-on-boot
  command is configured but not executed end-to-end this phase).
- Scheduled pruning of expired `idempotency_keys` rows (application-phase job).
- Performance/load behaviour of the pool under concurrency (no load test yet;
  functional reservation test ran single-threaded).
- Host port 5432 belongs to a native PostgreSQL 18 service — it was not
  stopped or modified; the project uses 5433 for its own container.
