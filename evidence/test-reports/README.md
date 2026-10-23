# Phase 2 — Verification Evidence

Date: 2026-10-21 (run on the local development machine, Windows / Node v24.17.0 / npm 11.13.0)

All commands were executed against the code in this repository. Raw command output is
saved alongside this summary in this `evidence/test-reports/` directory. No result below
is extrapolated — these are the actual observed outcomes.

## Summary of ACTUAL results

| Command | Result | Notes |
|---|---|---|
| `npm --prefix backend test` (Node test runner + Supertest) | PASS — 10 tests, 5 suites, 0 fail | health, helmet headers, 404 envelope, no-stack-leak, malformed JSON → 400, oversized body → 413, logger redact, ApiError. See `backend-test.txt`. |
| `npm --prefix frontend test` (Vitest + React Testing Library) | PASS — 2 tests, 1 file | landing page loading→success and error+retry states (fetch mocked). See `frontend-test.txt`. |
| `npm run lint` (ESLint, backend + frontend) | PASS — exit 0, 0 errors | backend & frontend. See `lint.txt`. |
| `npm --prefix frontend run build` (Vite production build) | PASS — 30 modules, built in ~0.9s | `dist/` emitted. See `frontend-build.txt`. |
| `npm run format:check` (Prettier) | PASS — "All matched files use Prettier code style!" | after `npm run format` normalized 3 files. See `format-check.txt`. |
| `npm test` (aggregate backend + frontend) | PASS — exit 0 | See `test.txt`. |
| Runtime smoke: `node src/server.js` then `GET http://localhost:4000/api/health` | PASS — `{"status":"ok","uptimeSeconds":2,"timestamp":"..."} ` | See `smoke.txt`. |

## Not yet measured / not performed (honesty per acceptance-criteria.md §10)

- Docker image build & `docker compose up` health orchestration: **not run in this
  phase** (Docker CLI is present, version 29.9.1). Compose/Dockerfiles are provided and
  validated by review only. Run `docker compose up --build` to verify NFR-DEPLOY-01.
- Graceful shutdown SIGINT/SIGTERM drain: handlers are **implemented and unit-covered by
  code review**, but not exercised at runtime in this phase (process was stopped via
  kill during smoke test). Documented manual procedure in README.
- Performance/load, RBAC, and business-module acceptance criteria: **out of scope for
  Phase 2** (no auth or business modules implemented yet, as instructed).
