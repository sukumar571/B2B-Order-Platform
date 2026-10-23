# Demo Script — B2B Order Management Platform (5–7 minutes)

A narrated walkthrough of the **full order lifecycle** proving the two headline guarantees:
**real-time stock that cannot be oversold** and **server-authoritative, audited money**.
Every screen and value shown here is produced by the running application — nothing is mocked.

## Before you start (do not narrate this)

```bash
# Option A — Docker stack (recommended, shows the deployment path)
cp .env.example .env        # set a real POSTGRES_PASSWORD + ≥32-char JWT secrets
npm run docker:up           # db → migrate → backend → frontend
npm run docker:seed         # idempotent demo data (skips if already present)
# open http://localhost:8080

# Option B — local dev (two terminals) against the host-published DB
npm run db:up && npm run db:migrate && npm run db:seed
npm run dev:backend         # :4000
npm run dev:frontend        # :5173
```

Dev seed accounts (password `Passw0rd!`, **dev-only**): `admin@b2boms.test`,
`agent@b2boms.test` (ORDER_MANAGER), `customer@b2boms.test`, `disabled@b2boms.test`.
The seed creates **6 products** with inventory. Confirm the landing page shows
**"connected"** (it calls `GET /api/health`).

> Tip: navigate protected screens by **clicking** (navbar / row links), not by pasting URLs —
> the access token lives in memory and a cold reload rehydrates from the refresh cookie.

---

## 0:00 – 0:30 · The problem, in one screen

Open the landing page. One sentence: *"This replaces the email-and-spreadsheet order flow —
customers order against live stock, and every change is priced server-side and audited."*
Point at the health badge → "the SPA is talking to the real API and database, no mock data."

## 0:30 – 1:30 · Admin manages catalog & stock (role: ADMIN)

1. **Log in** as `admin@b2boms.test`.
2. Go to **Admin → Products**. Show the table (name, SKU, price, tax, active, availability).
3. *(Optional, ~20 s)* **Add a product** — then immediately try to **reuse its SKU** and show the
   **`409 DUPLICATE_SKU`** error. Say: *"unique SKU is enforced in the database, not just the UI."*
4. Go to **Inventory**. Adjust stock for one product (signed delta + reason) and open its
   movement to show the **`inventory_movements`** ledger entry appears.
   **Narrate:** *"every stock change is journalled and attributed to who did it."*

## 1:30 – 3:00 · Customer places a validated order (role: CUSTOMER)

5. **Log out**, log in as `customer@b2boms.test`.
6. **Browse** Products, **search**, open a **product detail**. Note availability shown.
7. **Add to cart**, then add the same product again → the **quantity merges** into one line
   (no duplicate row). Show the **server-computed** subtotal, tax, grand total.
   **Narrate:** *"those totals come from the server's decimal math — the client never decides price."*
8. **Place the order** (copy the order number). Immediately open **Inventory** for that product
   and show **available stock dropped** by the ordered quantity — reservation happened atomically.

## 3:00 – 4:00 · The oversell guard (the money shot)

9. In a **second/incognito** window, log in as the customer again (or reuse). Note the product's
   last-available quantity. Try to order **more than available** → the UI/API returns
   **`409 INSUFFICIENT_STOCK`** and stock is **unchanged**.
   **Narrate:** *"row-level locking means two simultaneous buyers can never oversell the same unit."*
   (This exact guarantee is covered by an automated 20-way concurrency integration test —
   see `test-results.md` §3 / SC-02.)

## 4:00 – 5:00 · Fulfilment & automatic invoice (role: ORDER_MANAGER / agent)

10. **Log out**, log in as `agent@b2boms.test`.
11. Open **Order processing**. Try to **Fulfil a `pending` order directly** →
    **`409 INVALID_STATE_TRANSITION`** (confirm must precede fulfil). Then **Confirm → Fulfil**.
12. Fulfilment **mints exactly one invoice** — open it (print view). Point out:
    - the **sequential invoice number** `INV-YYYY-NNNNNN`,
    - line items with **snapshotted** name/price,
    - `grand total = subtotal + tax` **equal to the order total**.
    **Narrate:** *"the invoice is generated inside the fulfilment transaction — it can't drift from the order."*

## 5:00 – 5:45 · Audit trail & dashboard (back to ADMIN)

13. **Log in** as `admin@b2boms.test` → **Audit logs**: show the rows for the login, product,
   stock-adjust, order create/confirm/fulfil and invoice events (actor, action, entity, time).
   **Narrate:** *"append-only — there is no API to edit or delete these."*
14. Open **Dashboard**: live totals / low-stock signals aggregated from the same data.

## 5:45 – 6:15 · Access control (close on trust)

15. As the **customer**, try to reach an admin screen / call a staff endpoint → it's blocked
    (`403`/`404`); a customer cannot see another customer's order (foreign id → **404**, not a
    leaked 403). Optionally show `disabled@b2boms.test` **cannot log in**.
    **Narrate:** *"role enforcement is server-side on every endpoint; the menu hiding things is
    just UX."*

## 6:15 – 7:00 · Wrap

Summarise in one breath: *real-time inventory with a proven no-oversell guard, server-priced
money, automatic invoicing, full audit, and RBAC — delivered as a same-origin React + Express +
PostgreSQL app that runs from a single `docker compose up`, backed by **352 automated checks**
(228 backend + 74 frontend + 17 browser E2E) and a **9/9** post-deploy smoke, all with **0
failures*.* Then state the honesty line: *"performance under load and real-user pilot timing were
not measured, and multi-tenant/payment features are out of scope — those are documented."*

---

### If something misbehaves mid-demo

- Health badge red → the API/DB isn't up: `npm run docker:ps` / `npm run docker:logs`.
- Ports busy for `dev:` mode → stop stray servers, or use the Docker option.
- Stock too low to demo an order → `npm run docker:seed` again (it skips if data exists) or
  raise stock in Inventory as admin.

Screenshots of these screens are in [`../evidence/screenshots/`](../evidence/screenshots/)
(catalog, product detail, admin table, inventory + low-stock, printable invoices, etc.).
