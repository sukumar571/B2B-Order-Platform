# Deployment & Containerization Guide — B2B Order Management Platform

**As-built in Phase 13 (Docker & reproducible deployment).** Every command and result in
§9 was executed on this working tree (Docker Engine 29.9.1, Docker Compose v5.6.0,
PostgreSQL 16.15, Node 20-alpine images, Windows host). Related docs:
[`architecture.md`](architecture.md) · [`api-specification.md`](api-specification.md) ·
[`database-design.md`](database-design.md) · [`test-plan.md`](test-plan.md) ·
decision [**D-29**](decision-log.md).

---

## 1. What ships in which container

| Service | Image / build | Runs as | Listens on | Published to host (base file) |
|---|---|---|---|---|
| `db` | `postgres:16-alpine` | `postgres` (image default) | `5432` (internal network only) | **no** |
| `migrate` | `b2b-oms-api:<tag>` (built from `backend/Dockerfile`) | `node` (uid 1000) | one-shot, exits | no |
| `backend` | `b2b-oms-api:<tag>` | `node` (uid 1000) | `4000` | no |
| `frontend` | `b2b-oms-web:<tag>` (Vite build → `nginx:1.27-alpine`) | nginx master `root`, workers `nginx` | `80` | **yes** — `${WEB_PORT:-8080}` |

Request path for a browser at `http://localhost:8080`:

```
browser ──▶ nginx (frontend container)
             ├── /            → static SPA (try_files … /index.html  → client-side routes)
             └── /api/…       → proxy_pass http://backend:4000  → Express → db:5432 (PostgreSQL)
```

Two consequences that matter:

- **The SPA never needs to know the API host.** `frontend/src/services/api.js` uses
  relative `/api` unless `VITE_API_BASE_URL` is set, and nginx proxies that path to the
  `backend` service. One origin ⇒ no CORS, and the auth refresh cookie stays first-party.
- **Containers must address PostgreSQL by the Compose service name** (`db:5432`), never
  `localhost:5433`. `localhost` inside a container is that container itself. The
  Compose-managed `DATABASE_URL` reflects this; the host-side development
  `DATABASE_URL` (`localhost:5433`) is a *different* endpoint onto the same server and is
  only valid for processes running on the host.

## 2. Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Production-shaped stack: `db`, `migrate`, `backend`, `frontend` (+ optional `seed`). Only the web port is published. |
| `docker-compose.dev.yml` | Local override that publishes PostgreSQL `5433` and the API `4000` for host-side scripts, the Vite dev server and the test suites. **Never for production.** |
| `backend/Dockerfile` | Multi-stage (deps → runtime), `npm ci --omit=dev` from the lockfile, `USER node`, `HEALTHCHECK` on `/api/health`. |
| `frontend/Dockerfile` | Multi-stage (`node:20-alpine` build → `nginx:1.27-alpine` serve), copies only `index.html`, `vite.config.js`, `src/`. |
| `backend/.dockerignore`, `frontend/.dockerignore` | Exclude `node_modules`, logs, test/build artifacts **and every `.env`** from the build context. |
| `frontend/nginx.conf` | SPA fallback, `/api` proxy, forwarded `Host`/`X-Real-IP`/`X-Forwarded-For`/`X-Forwarded-Proto`, `nosniff` + `X-Frame-Options` headers. |
| `.env.example` | Root (Compose) environment template — the only place deployment values are documented. |
| `scripts/deploy-smoke.js` | Read-only post-deploy verification through the public browser origin (§9). |

## 3. Configuration and secrets

**Nothing sensitive is hardcoded.** No `.env`, password or JWT secret appears in any image,
Dockerfile or in `docker-compose.yml`:

- Secrets are interpolated at **`docker compose` parse time** from the git-ignored root
  `.env`. Required values use the `${VAR:?message}` form, so Compose **fails fast with an
  actionable message** rather than starting a container with a missing or placeholder
  secret (verified in §9, row "fail-fast").
- No Dockerfile `COPY`s `.env*`; both `.dockerignore` files exclude them, so a stray
  `backend/.env` can never be baked into an image or a `vite build` bundle.
- Non-secret knobs (`POSTGRES_USER`, `POSTGRES_DB`, ports, image tag) keep documented
  defaults; secrets (`POSTGRES_PASSWORD`, `JWT_*`) do not.
- Defence in depth: even if a container started with a weak value,
  `backend/src/config/env.js` **refuses to boot** under `NODE_ENV=production` when a JWT
  secret is missing, shorter than 32 chars, still the dev default, or when
  `COOKIE_SECURE` is not `true`.

Setup:

```bash
cp .env.example .env     # then edit: real random JWT secrets, real DB password
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # one per secret
```

| Variable | Used by | Notes |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `db`, and the `DATABASE_URL` built from them | Password is **required**; also used by `pg_dump`/`pg_restore`. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | API, migrate, seed | **Required**, ≥ 32 chars, unique per environment. Rotating either invalidates all live tokens. |
| `COOKIE_SECURE` | API | Default `true` (mandatory in production). |
| `CORS_ORIGINS` | API | Empty = same-origin only. Set only if the SPA is hosted apart from the API. |
| `WEB_PORT` | frontend | Public browser origin (8080 by default). |
| `POSTGRES_HOST_PORT` / `API_HOST_PORT` | dev override | `5433` / `4000`; exist only in `docker-compose.dev.yml`. |
| `B2B_IMAGE_TAG` | both images | `local` by default; pin to a release tag or git SHA when deploying. |

Full variable reference for host-side development lives in
[`backend/.env.example`](../backend/.env.example) and the README table.

## 4. Starting, stopping, logs

```bash
# Build both images and start the stack (db → migrate → backend → frontend)
npm run docker:up                 # = docker compose up -d
npm run docker:build              # rebuild images only
npm run docker:ps                 # service states + health
npm run docker:logs               # follow all logs (Ctrl+C to stop)
npm run docker:logs               # … or scope it: docker compose logs -f backend
npm run docker:down               # STOP and remove containers — data is NOT removed
```

Restart policy is `unless-stopped` for the long-running services, so a Docker daemon or
host reboot brings the stack back without intervention. The `migrate`/`seed` one-shots use
`restart: "no"` — a failed migration must not loop.

Local development against the same database (host-published ports):

```bash
npm run db:up          # db only, via docker-compose.dev.yml (publishes 5433)
npm run docker:up:dev  # whole stack + published 5433/4000
```

## 5. Database migration workflow (controlled, single-runner)

Migrations are **not** part of the API's boot command. `docker-compose.yml` defines a
dedicated one-shot `migrate` service:

```yaml
migrate:
  restart: 'no'
  command: ['node', 'scripts/db/migrate.js', 'up']
  depends_on:
    db: { condition: service_healthy }        # waits for real PostgreSQL readiness
backend:
  depends_on:
    db:      { condition: service_healthy }
    migrate: { condition: service_completed_successfully }
```

Why this shape:

- **Ordering is enforced, not assumed.** `pg_isready` gates `migrate`, and
  `service_completed_successfully` gates `backend`, so the API can never start against an
  un-migrated or still-initialising database.
- **One runner, not one per replica.** `docker compose up --scale backend=3` starts three
  API containers and still exactly **one** migration container (verified in §9), so
  replicas cannot race on `pgmigrations`.
- **Safe by construction.** `scripts/db/migrate.js` only applies or reverts the schema
  changes listed in `backend/migrations/` (18 reversible scripts). It never drops a
  database and never truncates data; `up` is idempotent ("No migrations to run!" on a
  current database).

Deploy-time sequence:

```bash
docker compose pull                 # (if images come from a registry)
npm run docker:build                # build the release images
docker compose up -d db             # database first
npm run docker:migrate              # = docker compose run --rm migrate  (explicit step)
npm run docker:seed                 # optional demo data; skips itself if any users/products exist
npm run docker:up                   # API + SPA
npm run docker:smoke                # verify through the browser origin
```

Rolling back the **last** migration (schema only, data-preserving where the script is
reversible — do it on a database you have backed up):

```bash
docker compose run --rm migrate down
```

## 6. Storage and data preservation

PostgreSQL stores its data directory in the named volume `pgdata`
(`<project>_pgdata`, e.g. `b2bordermanagementplatform_pgdata`).

| Action | Effect on data |
|---|---|
| `docker compose restart`, `stop`, `kill` | preserved |
| `docker compose down` | **preserved** — containers/networks removed, volume kept |
| image rebuild, `B2B_IMAGE_TAG` change | preserved |
| `docker compose down -v` | **DESTROYS the database** — see §8 |

Changing `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` only takes effect on a
**new** volume; an initialised volume keeps its original superuser/database, so a mismatch
appears as an authentication failure (fix the value, do not delete the volume).

## 7. Backup and restore

Backups run **inside** the `db` container, so they need no host `psql` and no published
port. Custom format (`-Fc`) keeps it compressed and selective-restorable.

```bash
# 1) Dump
docker compose exec -T db pg_dump -U b2b -d b2b_oms --format=custom --file=/tmp/b2b_oms.dump

# 2) Copy the archive to the host (byte-exact; `backups/` is git-ignored)
docker compose cp db:/tmp/b2b_oms.dump ./backups/b2b_oms.dump

# 3) Verify the copy (size + digest, and/or list its contents)
docker compose exec -T db pg_restore -l /tmp/b2b_oms.dump | head
Get-FileHash .\backups\b2b_oms.dump -Algorithm SHA256      # PowerShell
# sha256sum backups/b2b_oms.dump                           # Linux/macOS
```

Restore **into an empty database** — never onto a live one. Either recover in place:

```bash
docker compose stop backend
docker compose exec -T db dropdb -U b2b --if-exists b2b_oms_restore_target   # destructive
docker compose exec -T db createdb -U b2b b2b_oms_restore_target
docker compose exec -T db pg_restore -U b2b -d b2b_oms_restore_target --no-owner /tmp/b2b_oms.dump
```

…or restore side-by-side to prove an archive before swapping it in (the shape used in the
§9 verification run), then point `POSTGRES_DB`/`DATABASE_URL` at the verified database.
`pg_restore` on an empty target must exit 0 and reproduce the source's table and row
counts. Schedule dumps (cron / Task Scheduler / a `dbbackup` service) before you need
them; a volume is not a backup.

## 8. Destructive operations — require explicit human confirmation

**The platform never runs these automatically, and no script wraps them.** Each one
permanently destroys data. Confirm the target (project name, volume, database) out loud
and in writing before running any of them, and take a §7 backup first:

```bash
# ⚠ Deletes the PostgreSQL data volume — ALL database content is unrecoverable.
docker compose down -v

# ⚠ Deletes a volume by name (only if you know which project owns it)
docker volume rm <project>_pgdata

# ⚠ Drops a database inside the container
docker compose exec db dropdb -U b2b <database>

# ⚠ Reverts EVERY migration (schema destructively; prefer a fresh restored database)
npm --prefix backend run db:migrate:down -- --all
# ⚠ Resets the DISPOSABLE E2E database only (name-guarded: refuses any name not ending in _e2e)
npm run e2e:bootstrap
```

Compose project scoping is also a safety tool: `-p <name>` gives a stack its **own**
volume, so a test deployment cannot touch the data of another (`docker volume ls` shows
which is which). The E2E bootstrap additionally refuses to reset any database whose name
does not match `*_e2e` (Phase 12, D-28).

## 9. Verification performed in Phase 13

All rows are from commands actually executed on 2026-10-23 (IST) in a **separate Compose
project** (`-p b2b_p13_clean`) with its own volume, so the pre-existing development
database was never at risk. Raw output:
[`evidence/test-reports/phase13-docker-deployment.md`](../evidence/test-reports/phase13-docker-deployment.md).

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Static config validation (secrets missing → fail fast) | `docker compose config --quiet` | **PASS** — exit 1, names every missing required variable |
| 2 | Base + dev files parse | `docker compose -f … -f docker-compose.dev.yml config --quiet` | **PASS** — exit 0 |
| 3 | Base publishes only the web port | `docker compose config --format json` | **PASS** — `db`/`backend`/`migrate` publish nothing |
| 4 | Clean build from zero | `docker compose up -d --build` | **PASS** (after the §10 fix) — 2 images built, 4 containers |
| 5 | Readiness ordering | `docker compose ps -a` | **PASS** — db `Healthy` → migrate `Exited (0)` → backend `Healthy` → frontend `Healthy` |
| 6 | Migrations applied to an empty volume | `psql -c "select count(*) from pgmigrations"` | **PASS** — 18 applied, 14 public tables |
| 7 | Migration step is idempotent + controllable | `docker compose run --rm migrate` | **PASS** — "No migrations to run!", exit 0 |
| 8 | Migrations do not run per replica | `up -d --scale backend=3` | **PASS** — 3 healthy API containers, exactly 1 migrate container |
| 9 | App is healthy through the browser origin | `npm run docker:smoke` | **PASS** — 9/9 (SPA `/`, `/products`, `/login`; `/api/health` `db.state=up`; catalog; anon `401`; admin login; cookie `HttpOnly; Secure; SameSite=Strict`; admin dashboard) — also 9/9 with 3 replicas |
| 10 | Demo seed via profile | `docker compose --profile tools run --rm seed` | **PASS** — "Seeded 4 users … 6 products"; second run skips |
| 11 | API runs unprivileged | `docker exec backend id` | **PASS** — uid 1000 `node` |
| 12 | No `.env`, no devDependencies, no test files in the image | `docker run --rm --entrypoint sh … ls` | **PASS** — `bcryptjs/pg/zod` present, `eslint/supertest/globals` absent, no `.env*` |
| 13 | Secrets fail closed inside the container | `run -e JWT_ACCESS_SECRET=short-secret backend node -e require(env)` | **PASS** — "JWT_ACCESS_SECRET is too weak for production (>= 32 chars…)" |
| 14 | `COOKIE_SECURE` enforced | same, `-e COOKIE_SECURE=false` | **PASS** — "COOKIE_SECURE must be true in production" |
| 15 | Data survives a full stop | `down` → `up -d` → `psql` counts | **PASS** — volume kept; 4 users / 6 products / 6 inventory / 18 migrations intact |
| 16 | Backup | `pg_dump -Fc` + `docker compose cp` | **PASS** — 48 790 bytes, sha256 `06F4E2CA…1FDCB` |
| 17 | Restore into a scratch database | `createdb` + `pg_restore --no-owner` | **PASS** — exit 0; 14 tables, 4/6/6/18 rows identical to source |
| 18 | Dev override gives host access | `npm run db:up` + `npm run db:health` | **PASS** — host process reached `localhost:5433`; schema complete, 18 migrations |
| 19 | No regression to the existing dev database | `psql` on `b2bordermanagementplatform-db-1` | **PASS** — `b2b_oms` / `b2b_oms_test` / `b2b_oms_e2e` all present, 7 users / 10 orders / 102 audit rows intact |

**One real defect was found and fixed by this work** (§10), which is precisely what a
containerized deployment check is for.

## 10. Known issues, fixes and limitations

- **Fixed in Phase 13 — `bcryptjs` was declared as a `devDependency`.**
  `backend/src/services/auth.service.js` requires it at runtime, so the freshly built
  production image (`npm ci --omit=dev`) crashed with `Cannot find module 'bcryptjs'` and
  the API never became healthy, even though every host-side test passed (a host install
  always has devDependencies). It is now in `dependencies` and
  `backend/package-lock.json` was regenerated. Verification: row 4/9 above (fails before,
  9/9 after). This is recorded as a Phase 13 finding, not a pre-existing known failure.
- **HTTPS is not terminated inside these containers.** The provided nginx config listens
  on port 80 only. In a real deployment put the SPA behind TLS (a cloud LB, or a host
  reverse proxy such as Caddy/Traefik/nginx with certificates) and keep
  `COOKIE_SECURE=true`. `X-Forwarded-Proto` is already forwarded for the proxy layer.
  The local demo works over plain `http://localhost` because browsers treat `localhost` as
  a trustworthy origin and still send `Secure` cookies there; that exception does **not**
  extend to any other hostname.
- **`nginx:1.27-alpine` keeps a root master process** (unprivileged workers as `nginx`).
  The application process is rootless; to make the whole container rootless, switch to
  `nginxinc/nginx-unprivileged` and adjust the port (it listens on 8080 internally).
  Left as-is deliberately: it is the standard, well-supported image and the worker model is
  already unprivileged.
- **Base images are pinned to major/minor tags** (`node:20-alpine`, `nginx:1.27-alpine`,
  `postgres:16-alpine`) and dependency installs use `npm ci` from committed lockfiles. For
  supply-chain reproducibility, digest-pin them (`node:20-alpine@sha256:…`) in a real
  deployment.
- **Single-node scope.** No Swarm/Kubernetes manifests, no registry push, no CI pipeline;
  `pgdata` is a local volume, so this composition is not replicated or backed up off-host
  automatically. Rate limiting is in-process, so scaling the API multiplies the effective
  limit unless it moves to a shared store (documented in
  [`architecture.md`](architecture.md)).
- **In-memory access tokens** (D-19) mean a container restart signs everyone out — expected,
  but worth knowing when rolling out replicas.
- **Seed data is dev-only.** `database/seeds/` is mounted read-only into the optional
  `seed` one-shot rather than baked into an image, and the seeded password
  (`Passw0rd!`) is a documented development fixture. Never run `docker:seed` against a
  real environment.
- **The `e2e` workspace is not containerized** — Playwright starts its own API/SPA
  processes on the host against the disposable `b2b_oms_e2e` database (D-28). Browser
  journeys against the Docker stack remain future work; `npm run docker:smoke` covers the
  deployed paths HTTP-wise.
