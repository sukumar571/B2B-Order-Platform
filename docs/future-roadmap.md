# Future Roadmap — B2B Order Management Platform

Realistic, prioritised next work — each item addresses a limitation disclosed in
[`limitations.md`](limitations.md) / [`security-review.md`](security-review.md). Effort is
rough (S/M/L); ordering favours correctness/scale safety and quick wins first. **No item below
is complete today** — this is a plan, not a status.

## Now — before any real production traffic (correctness & safety)

| # | Item | Addresses | Effort |
|---|---|---|---|
| 1 | **Terminate TLS** (Caddy/Traefik or cloud LB) in front of nginx; keep `COOKIE_SECURE=true` | R-1 / NFR-01 | S |
| 2 | **Move rate limiting to Redis** so limits hold across replicas | R-4 | S |
| 3 | **Shared token revocation** (deny-list / refresh-family store in Redis) so logout & disable revoke instantly | R-3 | M |
| 4 | **Secrets from a managed store** (Vault/SSM/Doppler) with rotation; stop relying on env files | R-2 | M |
| 5 | **CI pipeline**: lint + test + `npm audit` + `gitleaks` + build on every push; publish images to a registry | R-9 / NFR-10 | M |
| 6 | **Load benchmark** (k6/artillery, 20 vus) and report measured p95 — replace SC-07 "not measured" | NFR-05 / SC-07 | M |
| 7 | **Scheduled, off-host `pg_dump`** with a restore drill; alert on failure | NFR-14 | S |

## Next — operational hardening & observability

| # | Item | Addresses | Effort |
|---|---|---|---|
| 8 | Structured logging + metrics (pino → Loki/Grafana, `/metrics` via `prom-client`) | ops | M |
| 9 | **Digest-pin base images** (`@sha256`) and add image scanning (Trivy/Snyk) | R-8 | S |
| 10 | Rootless web (switch to `nginxinc/nginx-unprivileged`) | R-7 | S |
| 11 | Error tracking (Sentry) + request IDs propagated through logs/audit | ops | S |
| 12 | Containerised Playwright (E2E against the running Docker stack, Chromium **and** Firefox) | limits §2 | M |

## Later — business features (scope growth)

| # | Item | Addresses | Effort |
|---|---|---|---|
| 13 | **Payment integration** (Razorpay/Stripe) with a ledger + webhook reconciliation | §1 payments | L |
| 14 | **Per-customer price lists, discounts, credit limits** | §1 pricing | L |
| 15 | **Multi-warehouse / batch-lot inventory** and stock transfers | §1 inventory, A-02 | L |
| 16 | **Self-service password reset + email verification** | K-1 | M |
| 17 | **CSV/Excel export** of orders/invoices/reports + scheduled statements | K-2 / §1 reporting | S |
| 18 | **Shipping/fulfilment** integration + partial line acceptance | §1 shipping, A-04 | L |
| 19 | Multi-jurisdiction **tax engine** (GST/VAT classes, rounding rules) | §1 tax | L |
| 20 | **Multi-tenant** isolation (tenant column + Postgres RLS, tenant-scoped keys) | §3 single-tenant | L |

## Continuous / nice-to-have

- **Realtime stock/order updates** (SSE/WebSocket) and optimistic UI with server re-validation.
- **Notifications** (email/webhook) on order state change & low-stock thresholds.
- **Advanced search** (Postgres FTS / trigram) replacing ILIKE.
- **Accessibility pass** (WCAG AA audit; keyboard nav, contrast, ARIA).
- **Dashboard trend charts** over time ranges and exportable snapshots.
- **Idempotency coverage** extended beyond orders to inventory adjustments.
- **Soft-delete + retention policy** and GDPR-style data export/anonymisation for customers.

## Sequencing rationale

Correctness and scale-safety items (TLS, distributed rate limiting, shared revocation, secrets,
CI, load data) come first because they are prerequisites for safely serving more than a demo
load and because they retire the *un-measured* claims now honestly flagged in the traceability
matrix. Business features (payments, pricing, multi-tenant) are larger and can follow real
demand signals. Every item should land with tests and a decision-log entry, matching the
documentation-first convention used across Phases 1–13.
