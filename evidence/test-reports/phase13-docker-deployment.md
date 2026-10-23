# Phase 13 — Docker & Reproducible Deployment: deployment evidence

Date: 2026-10-23 (IST). Environment: Windows host, Docker Engine **29.9.1**, Docker
Compose **v5.6.0**, host Node **v24.17.0**; images built from `node:20-alpine`
(runtime Node 20.20.2), `nginx:1.27-alpine`, `postgres:16-alpine` (server **16.15**).

Docker **was available**, so this phase is verified **at runtime**, not only statically.
Every command and figure below was executed on this working tree. Raw console output is
captured alongside in:

- [`phase13-compose-config.txt`](phase13-compose-config.txt) — static validation + resolved ports/deps
- [`phase13-image-audit.txt`](phase13-image-audit.txt) — image user, healthcheck, dependency & secret hygiene
- [`phase13-clean-deploy.txt`](phase13-clean-deploy.txt) — build, ordering, migrate, seed, scale, smoke
- [`phase13-failclosed.txt`](phase13-failclosed.txt) — production secrets refuse weak/insecure values
- [`phase13-persistence-backup.txt`](phase13-persistence-backup.txt) — full-stop persistence + pg_dump/pg_restore round-trip

> The captures were produced on a Windows PowerShell console. Where a native command
> writes to stderr (Compose progress), PowerShell wraps the line in a `NativeCommandError`
> record and the em-dash/box-drawing glyphs render as `ΓÇö`; this is **console noise, not a
> command failure** — the `exit code:` line after each block is authoritative.

---

## 1. Isolation — the development database was never at risk

Every destructive-capable test ran in a **separate Compose project** with its **own**
volume, so the pre-existing development data was structurally unreachable:

| Compose project | Volume | Purpose | Outcome |
|---|---|---|---|
| `b2b_p13_clean` | `b2b_p13_clean_pgdata` | first clean build | surfaced the `bcryptjs` defect (§5) |
| `b2b_p13_final` | `b2b_p13_final_pgdata` | full documented flow | all checks below |
| `b2bordermanagementplatform` | `b2bordermanagementplatform_pgdata` | **the user's dev stack** | **untouched** — verified healthy on host `:5433` throughout |

No `-v` / `volume rm` / `dropdb b2b_oms` was ever run against the dev project. The three
`b2b_p13_*` test volumes are **left in place** (see §7); their removal is offered but not
executed, per the "never delete data automatically" constraint.

---

## 2. Static validation (`docker compose config`)

| Check | Result |
|---|---|
| Base file with **no secrets** (`--env-file .env.empty`) | **exit 1 — fails fast**, naming `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` as required (the `${VAR:?…}` interpolation) |
| Base file with secrets supplied | **exit 0** |
| Base + `docker-compose.dev.yml` | **exit 0** |
| Resolved published ports (base = production shape) | `db` `[]`, `backend` `[]`, `migrate` `[]`; **only `frontend` → `8099:80`** |
| Resolved ordering | `migrate` `restart=no`, `depends_on: db (service_healthy)`; `backend` `depends_on: db (healthy) + migrate (service_completed_successfully)` |
| Healthchecks present | `backend`, `db` |

This is the concrete proof that PostgreSQL is **not published** in the production-shaped
file and that readiness/one-shot ordering is enforced by Compose, not by luck.

## 3. Image audit (built `b2b-oms-api:local` / `b2b-oms-web:local`)

| Property | API image | Web image |
|---|---|---|
| `Config.User` | `node` (runtime `id` → `uid=1000(node)`) | nginx (master root, workers `nginx`) |
| `Healthcheck` | `node -e fetch('/api/health')` | `curl -fsS / && curl -fsS /api/health` |
| `Cmd` | `node src/server.js` | `nginx -g daemon off;` |
| `/app` tree | `migrations node_modules package.json scripts src` — **`.env` count: 0** | `50x.html assets index.html` — **`.env` count: 0** |
| devDependencies leaked | **NONE** (`eslint/supertest/globals/nodemon/vitest` absent) | n/a |
| runtime deps present | `bcryptjs cookie-parser cors express helmet jsonwebtoken pg zod` | n/a |
| size | 226 MB | 74 MB |

Confirms: multi-stage build strips dev tooling, no `.env` or test source is baked in, and
the API process runs **non-root**.

## 4. Clean deployment from an empty volume

`docker compose -p b2b_p13_final up -d --build` → **exit 0**. Startup ordering observed:
`db Healthy` → `migrate Exited (0)` → `backend Healthy` → `frontend Healthy`.

| Step | Command | Result |
|---|---|---|
| Migrations on a fresh DB | `psql -f check.sql` | **18** applied migrations, **14** public tables |
| Controlled, idempotent migrate | `run --rm migrate` | "No migrations to run!" — exit 0 |
| Optional seed (profile) | `--profile tools run --rm seed` | "Seeded 4 users (dev password: Passw0rd!) and 6 products with inventory." |
| Seed is safe to re-run | same command | "Existing data found — seed skipped (nothing was changed)." |
| Single migration runner under scale | `up -d --scale backend=3` | 3 healthy API replicas, **exactly one** `migrate` container (Exited 0) |
| Deploy smoke (browser origin) | `node scripts/deploy-smoke.js http://localhost:8099` | **9/9 PASS** |

The 9 smoke checks: SPA `/`, `/products`, `/login` (real HTML shell); `GET /api/health`
via the nginx proxy → `{"status":"ok", … "db":{"state":"up"}}`; db-backed
`GET /api/products` (total=5 active); anonymous `GET /api/cart` → **401 UNAUTHENTICATED**;
admin `POST /api/auth/login` → 200; refresh cookie flags **`HttpOnly; Secure;
SameSite=Strict`**; `GET /api/reports/dashboard` (ADMIN) → 200. Also 9/9 with 3 replicas.

## 5. Real defect found and fixed — `bcryptjs` was a `devDependency`

The **first** clean build (`b2b_p13_clean`) left the backend container permanently
`unhealthy`: `Error: Cannot find module 'bcryptjs'` from
`backend/src/services/auth.service.js`. The runtime image installs with
`npm ci --omit=dev`, but `bcryptjs` — required at runtime for password hashing — was
declared under `devDependencies`. Every host-side test passed because a host install
always includes devDependencies; only the container path exposed it.

**Fix:** promoted `"bcryptjs": "^3.0.3"` to `dependencies` in `backend/package.json` and
regenerated `backend/package-lock.json` (its `dev` flag cleared). Rebuild → healthy;
`9/9` smoke; image audit now lists `bcryptjs` among the production deps. This is a Phase 13
finding that is now resolved, not a known-failure carried forward.

## 6. Persistence and backup/restore

| Step | Evidence |
|---|---|
| Counts before stop | `4 users / 6 products / 6 inventory / 0 orders / 18 migrations / 14 tables` |
| `down` (**no `-v`**) | containers/network removed, **`b2b_p13_final_pgdata` still present** |
| `up -d` restart, direct re-check | identical `4 / 6 / 6 / 0 / 18 / 14` — **data survived** |
| `pg_dump -Fc` in-container | `/tmp/b2b_oms.dump` = **48,783 bytes** |
| `docker compose cp` to host + digest | `SHA256 37dd8b8e803df4c9a09f34cd372701cb095bcb93261119f571a2fdce8855e2f6` |
| `pg_restore -l` | 135 TOC entries, dumped from PostgreSQL 16.15 |
| Restore into empty scratch DB | `createdb b2b_oms_restore_check` + `pg_restore --no-owner` → exit 0, counts `4 / 6 / 6 / 0 / 18 / 14` identical to source |
| Cleanup | `dropdb` **only** the scratch DB; `pg_database` = `b2b_oms, postgres, template0, template1`; final `down` preserved the volume |

## 7. Destructive operations — none executed automatically

No command that deletes volumes or database data was run. The three test volumes remain:

```
b2b_p13_clean_pgdata   b2b_p13_fresh_pgdata   b2b_p13_final_pgdata
```

Removing them is **deliberately left to a human** (docs/deployment.md §8). To discard the
Phase 13 test data once reviewed, the operator must confirm and run — **this destroys those
databases irreversibly**:

```bash
docker compose -p b2b_p13_final down -v   # and the same for b2b_p13_clean / b2b_p13_fresh
# or by name:
docker volume rm b2b_p13_clean_pgdata b2b_p13_fresh_pgdata b2b_p13_final_pgdata
```

The development volume `b2bordermanagementplatform_pgdata` must **not** be included.

## 8. Result

All Phase 13 acceptance criteria are met and verified at runtime: multi-stage, non-root,
healthchecked images; secrets excluded from images and interpolated fail-fast from the
git-ignored root `.env`; PostgreSQL unpublished in the production shape and reachable only
by the `db` service name; a single controlled migration step (proven under `--scale
backend=3`); data preserved across a full stop; a working `pg_dump`/`pg_restore`
round-trip; and a `9/9` smoke through the browser origin. `docs/deployment.md` documents
topology, secrets, HTTPS, backup/restore and the destructive/limitation notes; README and
decision **D-29** record the design choices.
