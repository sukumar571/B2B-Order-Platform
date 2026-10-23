'use strict';

/**
 * Aggregation queries for the Phase 9 dashboard/reports.
 *
 * METRIC DEFINITIONS are pinned here and mirrored in the docs — the dashboard
 * reports ONLY what the data can actually prove:
 *
 *  - "Total orders"        — count of order rows (all statuses) in the window.
 *  - "Orders by status"    — a count per lifecycle status in the window.
 *  - "Booked order value"  — SUM(grand_total) of orders that were NOT cancelled
 *        within the window. This is the value of demand PLACED, NOT collected
 *        revenue: the platform never takes payment (payments are out of scope,
 *        requirements.md §3.2), so there is nothing to call "revenue" honestly.
 *  - "Low-stock products"  — inventory rows where available_quantity <=
 *        low_stock_threshold (the same rule the catalog uses — migration 14).
 *
 * The window is a [from, to] half-open... INCLUSIVE range on orders.created_at,
 * supplied by the service (default: the trailing 30 days). All parameterized.
 */

const { query } = require('../db/pool');

function windowClause(from, to, args) {
  const clauses = [];
  if (from) {
    args.push(from);
    clauses.push(`created_at >= $${args.length}::timestamptz`);
  }
  if (to) {
    args.push(to);
    clauses.push(`created_at <= $${args.length}::timestamptz`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * Single-pass order aggregates for the window. Money comes back as NUMERIC
 * strings (exact) — the service forwards them verbatim (D-09); never floats.
 */
async function orderAggregates({ from, to }) {
  const args = [];
  const whereSql = windowClause(from, to, args);
  const r = await query(
    `SELECT
        count(*)::int AS total_orders,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders,
        count(*) FILTER (WHERE status <> 'cancelled')::int AS active_orders,
        COALESCE(SUM(grand_total) FILTER (WHERE status <> 'cancelled'), 0)::text AS booked_value,
        COALESCE(SUM(grand_total), 0)::text AS gross_value_including_cancelled
       FROM orders ${whereSql}`,
    args
  );
  const row = r.rows[0];
  return {
    total_orders: row.total_orders,
    cancelled_orders: row.cancelled_orders,
    active_orders: row.active_orders,
    booked_value: row.booked_value,
    gross_value_including_cancelled: row.gross_value_including_cancelled,
  };
}

/** Orders grouped by status for the window (every status present at least once). */
async function ordersByStatus({ from, to }) {
  const args = [];
  const whereSql = windowClause(from, to, args);
  const r = await query(
    `SELECT status, count(*)::int AS count
       FROM orders ${whereSql}
      GROUP BY status
      ORDER BY count DESC, status ASC`,
    args
  );
  return r.rows.map((row) => ({ status: row.status, count: row.count }));
}

/** Count of currently low-stock products (instantaneous, not time-scoped). */
async function lowStockCount() {
  const r = await query(
    `SELECT count(*)::int AS total
       FROM inventory i
      WHERE i.available_quantity <= i.low_stock_threshold`
  );
  return r.rows[0].total;
}

module.exports = { orderAggregates, ordersByStatus, lowStockCount };
