'use strict';

const reportRepo = require('../repositories/report.repository');
const auditRepo = require('../repositories/audit.repository');
const orderRepo = require('../repositories/order.repository');
const inventoryRepo = require('../repositories/inventory.repository');
const { ORDER_STATUS_VALUES } = require('../constants/orders');
const {
  reportQuerySchema,
  inventoryListQuerySchema,
  validateInput,
} = require('../utils/validators');

/**
 * Dashboard / report domain logic (Phase 9). Every figure is derived ONLY from
 * rows the system actually holds — nothing is estimated or fabricated. The two
 * most important honesty guarantees:
 *
 *  - ORDER VALUE ≠ REVENUE. This platform never captures payment (payments are
 *    out of scope). What we report as "booked order value" is SUM(grand_total)
 *    over NON-CANCELLED orders placed in the window — the value of DEMAND, not
 *    money collected. We report no revenue figure at all.
 *  - A metric is labelled with an explicit definition + its limitation, both in
 *    this payload (`metric_definitions`) and in docs, so a reader cannot mistake
 *    a booked figure for settled revenue or an inventory snapshot for a forecast.
 */

const DEFAULT_WINDOW_DAYS = 30;
const RECENT_ORDERS = 5;
const RECENT_AUDIT = 12;

/** Resolve the [from, to] window; default = the trailing DEFAULT_WINDOW_DAYS. */
function resolveWindow(rawQuery) {
  const q = validateInput(reportQuerySchema, rawQuery || {});
  const to = q.to || null;
  const from = q.from || null;
  let defaulted = false;
  let resolvedFrom = from;
  if (!from && !to) {
    resolvedFrom = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString();
    defaulted = true;
  }
  return {
    from: resolvedFrom,
    to,
    defaulted,
    // Echo the effective window so the UI shows exactly what was measured.
    window: { from: resolvedFrom, to, days: defaulted ? DEFAULT_WINDOW_DAYS : null },
  };
}

/** A zero-filled map of every lifecycle status → its in-window count. */
function foldStatus(breakdown) {
  const byStatus = Object.fromEntries(ORDER_STATUS_VALUES.map((s) => [s, 0]));
  for (const row of breakdown) byStatus[row.status] = row.count;
  return byStatus;
}

function metricDefinitions() {
  return {
    total_orders: 'Count of order rows created in the window, all statuses (including cancelled).',
    orders_by_status:
      'Orders created in the window grouped by lifecycle status; cancelled shown separately.',
    booked_order_value:
      'SUM(grand_total) of NON-CANCELLED orders created in the window. This is booked DEMAND, not collected revenue — the platform does not process payments, so no revenue figure is reported.',
    low_stock_products:
      'Products whose current available_quantity <= low_stock_threshold. An instantaneous snapshot, not a time-scoped or forecast figure.',
    recent_orders:
      'The most recent orders across all customers (newest first) — not filtered to the window.',
    recent_activity:
      'ADMIN only: the most recent audit events (who did what). Reflects recorded activity, not performance.',
    limitations:
      'All figures are derived solely from stored orders/inventory/audit rows. Order value is not revenue (no payment processing). Counts are live snapshots; the order window is based on orders.created_at.',
  };
}

/** Shared order-metric block used by BOTH the admin dashboard and the agent summary. */
async function orderMetrics(window) {
  const [aggregates, breakdown, lowStockCount] = await Promise.all([
    reportRepo.orderAggregates(window),
    reportRepo.ordersByStatus(window),
    reportRepo.lowStockCount(),
  ]);
  const recent = await orderRepo.listOrders({
    customerId: null,
    status: null,
    page: 1,
    limit: RECENT_ORDERS,
  });
  return {
    window: window.window,
    totals: {
      total_orders: aggregates.total_orders,
      cancelled_orders: aggregates.cancelled_orders,
      active_orders: aggregates.active_orders,
      booked_order_value: aggregates.booked_value,
      gross_value_including_cancelled: aggregates.gross_value_including_cancelled,
    },
    orders_by_status: foldStatus(breakdown),
    low_stock: { count: lowStockCount },
    recent_orders: recent.rows,
  };
}

/**
 * GET /api/reports/dashboard — ADMIN only. Full picture: order metrics PLUS the
 * audit activity feed and audit event count (which agents are NOT permitted).
 */
async function dashboard(rawQuery) {
  const window = resolveWindow(rawQuery);
  const [metrics, activity, eventCount] = await Promise.all([
    orderMetrics(window),
    auditRepo.recentAuditLogs(RECENT_AUDIT),
    auditRepo.countAll(),
  ]);
  return {
    data: {
      audience: 'admin',
      generated_at: new Date().toISOString(),
      ...metrics,
      audit: { total_events: eventCount, recent_activity: activity },
      metric_definitions: metricDefinitions(),
    },
  };
}

/**
 * GET /api/reports/order-summary — ADMIN + ORDER_MANAGER. The same order
 * metrics, but WITHOUT the audit feed (an agent's permitted view — no
 * who-did-what history, no cross-cutting admin data).
 */
async function orderSummary(rawQuery) {
  const window = resolveWindow(rawQuery);
  const metrics = await orderMetrics(window);
  return {
    data: {
      audience: 'order_manager',
      generated_at: new Date().toISOString(),
      ...metrics,
      metric_definitions: metricDefinitions(),
    },
  };
}

/** GET /api/reports/low-stock — ADMIN + ORDER_MANAGER. Paginated low-stock rows. */
async function lowStockReport(rawQuery) {
  const q = validateInput(inventoryListQuerySchema, rawQuery || {});
  const { rows, total } = await inventoryRepo.listInventory({
    search: q.search ?? null,
    activeOnly: false,
    lowStockOnly: true,
    page: q.page,
    limit: q.limit,
  });
  return { data: rows, meta: { page: q.page, limit: q.limit, total } };
}

module.exports = { dashboard, orderSummary, lowStockReport, resolveWindow, foldStatus };
