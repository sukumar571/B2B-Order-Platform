# Phase 10 — Complete Frontend Integration (evidence)

**Date:** 2026-10-22
**Scope:** Connect every delivered backend module to the React SPA, close the two remaining
frontend gaps (public customer **registration** and **authentication-expiry handling**), harden
the shared frontend engineering, add Vitest + React Testing Library coverage, and pass lint /
build / tests / format.

---

## 1. Pre-phase inspection

Audited `frontend/src` against the Phase 10 checklist. Prior phases (5–9) had already wired the
catalog, inventory, cart, orders, invoices, dashboard, audit and admin-users screens to live
endpoints through a single `services/api.js` client + `useApi` state machine + `RequireRole`
guards, so most of the surface only needed **verification**, not rewrites. Two real gaps and one
compliance issue stood out:

| Item | Backend support | Frontend before Phase 10 |
|---|---|---|
| Login | `POST /api/auth/login` | present |
| **Registration** | `POST /api/auth/register` (CUSTOMER-only) | **missing** (no page, no route, no client fn) |
| **Session rehydration on reload** | `POST /api/auth/refresh` (HttpOnly cookie) | **missing** (in-memory token lost on refresh → forced logout) |
| **Access-token expiry recovery** | `401 UNAUTHENTICATED` on expired access token | **missing** (no transparent refresh + retry) |
| Hardcoded demo credentials in login UI | — | **present** (seed emails + `Passw0rd!` shown on `/login`) |

## 2. Changes made

### API client (`services/api.js`)
- Added `register(body)`, `refresh()` (`credentials: 'include'`, `_skipAuthRefresh`), `me(token)`.
- Added a centralized **401 interceptor** (`setRefreshHandler`): an authenticated call that
  receives `401 UNAUTHENTICATED` invokes the injected refresher **once**, and on success replays
  the original request with the fresh bearer token. `login`/`register` send no token, so their own
  `401`s (bad credentials) are never retried. Recursion is bounded by `_skipAuthRefresh`.

### Auth context (`context/AuthContext.jsx`)
- Added `register(name,email,password)` (same in-memory token handling as `login`).
- Added `performRefresh(clearOnFail)`, **de-duplicated** via a shared in-flight promise so
  concurrent `401`s issue exactly **one** `/api/auth/refresh` (prevents replaying an
  already-rotated refresh token and tripping the backend's family-revocation defence).
- Registers the interceptor handler on mount; **silently rehydrates** the session on cold start
  (StrictMode-safe `bootstrapped` ref guard). A **bootstrap failure never clobbers** a
  concurrent/established login (`clearOnFail=false`), while a real expiry-driven failure does
  (`clearOnFail=true`) so guards redirect to `/login`.

### Registration page (`pages/RegisterPage.jsx`, new)
- `/register`: client validation mirroring the server Zod rules (email shape, name ≤ 120,
  password ≥ 10 with a letter + digit, confirm-match), accessible `aria-invalid`/`aria-describedby`
  wiring, `FormProblem` for server rejections, and a `submitting` guard that disables the button
  and ignores re-entry (no duplicate accounts). Posts **only** `name/email/password` — no `role`.

### Wiring & UI
- `App.jsx`: added `/register` route; refreshed the landing CTA (Browse / Create account) and
  replaced the stale "Phase 5" footer.
- `Navbar.jsx`: anonymous visitors now see **Log in** and **Register**.
- `LoginPage.jsx`: **removed the hardcoded seed-account/`Passw0rd!` hint** and linked to
  `/register`; corrected the doc comment.
- `styles-catalog.css`: added `.form__field-error` and `.form__hint` for the register form.
- `vite.config.js`: raised Vitest `testTimeout` to 20 000 ms (interaction-heavy RTL suites exceed
  the 5 s default on this Windows/jsdom runner when the whole file runs in parallel).

### Test maintenance
- `catalog.test.jsx`: made two `mock.mock.calls[0]` assertions order-independent because the
  `AuthProvider` now issues a mount-time refresh bootstrap before a page's first data fetch.

## 3. Verification (raw output captured in this folder)

| Command | Result |
|---|---|
| `npm --prefix frontend test` | **PASS** — 74/74 (63 prior + 11 new `auth.test.jsx`) |
| `npm --prefix frontend run lint` | **PASS** — 0 errors / 0 warnings |
| `npm run build:frontend` | **PASS** — 76 modules transformed, `dist/` emitted |
| `npm run format:check` | **PASS** — all files match Prettier style |

Files: `phase10-frontend-test.txt`, `phase10-frontend-lint.txt`, `phase10-frontend-build.txt`,
`phase10-format-check.txt`.

## 4. New test coverage (`src/test/auth.test.jsx`, 11 tests)

- **RegisterPage** — posts only `name/email/password` (asserts `role` is `undefined`) and lands the
  customer; blocks a weak password client-side with **no** request sent; surfaces a server `409`
  and stays on the form; **duplicate-submit guard** (one POST on a double click).
- **AuthContext** — restores a session from the refresh cookie on mount with no explicit login;
  stays anonymous when the cookie is rejected.
- **API client expiry** — a `401 UNAUTHENTICATED` triggers exactly one refresh + replay with the
  fresh bearer (`Authorization: Bearer jwt.fresh`); a login `401` is **not** retried.
- **Navbar** — role-aware links for customer (cart/my orders, no Users/Audit), admin (Users/
  Dashboard/Audit, no cart), and anonymous (Log in/Register).

## 5. Non-goals & integrity notes

- No backend changes were required: registration, refresh and `me` already existed and are
  server-authoritative (CUSTOMER-only registration, ownership-scoped reads, DB-enforced RBAC).
- Frontend role checks remain **UX-only**; every protected endpoint re-checks role/ownership.
- No mock data replaced any API integration; all figures rendered are server-calculated.
- The API base URL stays environment-driven (`VITE_API_BASE_URL`); no secrets or production data
  are hardcoded in shipped code.
