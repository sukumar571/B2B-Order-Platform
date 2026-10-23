# Limitations, Assumptions & Known Issues — B2B Order Management Platform

Honest statement of what this build **does not** do, the assumptions it rests on, and the
issues that remain. Cross-references: [`requirements.md`](requirements.md) §3.2/§7,
[`security-review.md`](security-review.md) §8, [`deployment.md`](deployment.md) §10,
[`requirements-traceability.md`](requirements-traceability.md) §5/§7.

> This project is a **functionally complete v1 for a single distributor tenant**, validated by
> automated tests that actually ran. It is **not** a hardened multi-tenant SaaS, and no business
> impact (revenue, time saved, error reduction) has been measured — those would require real
> pilot users, which were not available.

---

## 1. Functional scope limitations (by design)

| Area | Limitation |
|---|---|
| Payments | Invoices **record amounts only**; there is no payment gateway or settlement — collection is off-platform. |
| Shipping/logistics | Order lifecycle ends at `fulfilled`; no carrier integration, tracking, or partial shipment. |
| Inventory model | Single on-hand quantity per product (A-02): **no** multi-warehouse, batch/lot, expiry, or serial tracking. |
| Pricing | One base price per product, identical for all customers (A-03). **No** discounts, promotions, credit limits, volume tiers, or per-customer price lists. |
| Tax | A single configurable percentage per product; no jurisdictional/tax-class logic, no withholding. |
| Procurement | Sales side only — no purchase orders from the distributor to its suppliers. |
| Orders | Accepted or rejected **whole** (A-04); no line-level partial acceptance at creation. |
| Reporting | In-app dashboards + audit viewer exist, but **no CSV/Excel export**, no scheduled/BI export, no historical trend charts. |
| Invoices | Delivered by **on-screen/print-CSS download**; no email/attachment delivery. |
| Users | Password reset / self-service account recovery **not implemented**; admin creates/deactivates. |
| i18n/theming | English, single light theme; no localization or mobile-native apps. |

## 2. Non-functional limitations & un-measured claims

| Item | Status (honest) |
|---|---|
| **Performance under load (NFR-05 / SC-07)** | **Not measured.** No scripted 20-virtual-user latency test was run; the 20-way test proves **correctness** of the oversell guard, not p95 timing. |
| **Pilot usability timing (SC-06)** | **Not performed.** "≤ 10 minutes of training" was never validated with real users. |
| **Business impact** | **No measurement exists.** Claims about fewer order errors, faster invoicing, or prevented overselling describe the *intended* design; none are quantified from production data. |
| Browser coverage | Automated E2E ran **Chromium only**; Edge/Firefox and other viewports not exercised (NFR-09 target 1280 px Chrome/Edge). |
| UI step-counting (NFR-08) | Flows work end-to-end but were **not** formally counted against the "≤ 5 steps" target. |
| Availability / HA | Single container per service, one node; no replication, failover, or uptime SLA. |

## 3. Architectural & operational limitations

- **Single-tenant** (C-10): no tenant ID / row-level isolation; making it multi-tenant touches
  every query and the auth model.
- **Stateful auth trade-off (D-19):** access tokens are **in-memory** with **no server-side
  blocklist**; a restart or logout cannot revoke an unexpired 15-min access token beyond the
  short TTL. Refresh tokens *are* revocable (DB).
- **In-process rate limiting** — per-instance memory; horizontal scaling multiplies effective
  limits until a shared (Redis) store replaces it.
- **No CI/CD pipeline, no container registry, no IaC** — deployment is manual
  `docker compose` on one host.
- **TLS is not terminated in-container** — the provided nginx config serves plain HTTP; HTTPS is
  an external proxy/LB responsibility (`COOKIE_SECURE=true` is enforced so it must be paired
  with real TLS).
- **Secrets are environment variables** — no vault/KMS, no automated rotation; rotating a JWT
  secret invalidates all live tokens.
- **`nginx:1.27-alpine` keeps a root master** process (unprivileged workers); base images are
  tag-pinned, not digest-pinned.
- **No automated backup scheduler** — `pg_dump` is documented and proven but must be scheduled
  by the operator.
- **`node-pg-migrate` pinned to v7** (CommonJS, D-17); this transitively carries the accepted
  **2 high** `glob` advisories (D-27) that are unreachable in how migrations are run here.

## 4. Data & testing caveats

- Frontend component coverage gaps are **accepted and disclosed** (`LoginPage.jsx` 5.63 %,
  `UsersPage.jsx` 6.01 %) — those screens are covered by real browser journeys instead; the
  backend `requestLogger.js` is gated off unless `REQ_LOG=1`.
- The E2E run emits one **benign** log line (`pg.pool.error … terminating connection …`) from
  the guarded disposable-DB bootstrap; all 17 tests still pass.
- **Test data is synthetic.** Seeded demo users/products/inventory are fixtures (dev password
  `Passw0rd!`); the 500-product/200-customer set referenced by NFR-PERF-01 was **not** generated.
- Money fixtures (e.g. `19.99 × 3 @ 7.5 %` → `64.47`) are hand-computed arithmetic assertions,
  not observed business totals.

## 5. Environment assumptions

- Docker Engine + Compose available (verified: Engine 29.9.1 / Compose v5.6.0).
- Windows host dev uses host port **5433** for PostgreSQL because a native PostgreSQL occupies
  5432 (D-17); inside Compose the DB is always `db:5432`.
- Node ≥ 20 (developed on host v24, images on Node 20-alpine).
- Single organization, English-speaking staff, desktop-first usage.

## 6. Known issues open at delivery

| ID | Issue | Impact | Workaround / status |
|---|---|---|---|
| K-1 | No password reset / email verification | Admin must reset manually | Accepted v1 limitation (→ roadmap) |
| K-2 | No CSV/PDF export of reports | Manual capture only | Print-CSS invoice exists; report export → roadmap |
| K-3 | Cold `page.goto` to a protected route can briefly bounce to `/login` (memory-token rehydration race) | Only affects deep-link/refresh entry | E2E navigates by clicking; SPA rehydrates from the refresh cookie — mitigated, documented |
| K-4 | Backend `glob` advisories (D-27) | 2 high, unreachable path | Accepted & tracked with a re-review trigger |
| K-5 | Playwright `reuseExistingServer:false` needs ports 4000/5173 free | E2E won't start if dev servers linger | Stop dev servers before `npm run test:e2e` |

Items in **§2/§3 are not defects but scope boundaries**; they are listed so the evaluation
judges the delivered system against what was actually built and tested, not against a
full production SaaS.
