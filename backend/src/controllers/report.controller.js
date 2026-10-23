'use strict';

const reportService = require('../services/report.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * HTTP layer for dashboards/reports. Role gating is entirely at the route: the
 * full dashboard is ADMIN-only; the order-summary and low-stock report are the
 * staff (ADMIN + ORDER_MANAGER) view. The service only ever reports stored
 * figures and labels order value as booked (never revenue).
 */

/** GET /api/reports/dashboard — ADMIN — 200 { data }. */
const dashboard = asyncHandler(async (req, res) => {
  res.status(200).json(await reportService.dashboard(req.query));
});

/** GET /api/reports/order-summary — ADMIN + ORDER_MANAGER — 200 { data }. */
const orderSummary = asyncHandler(async (req, res) => {
  res.status(200).json(await reportService.orderSummary(req.query));
});

/** GET /api/reports/low-stock — ADMIN + ORDER_MANAGER — 200 { data, meta }. */
const lowStock = asyncHandler(async (req, res) => {
  res.status(200).json(await reportService.lowStockReport(req.query));
});

module.exports = { dashboard, orderSummary, lowStock };
