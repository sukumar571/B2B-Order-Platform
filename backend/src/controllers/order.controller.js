'use strict';

const orderService = require('../services/order.service');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ApiError } = require('../utils/errors');

/**
 * HTTP layer for orders. The acting user always comes from `req.user` (the
 * validated token) — a customer id is never read from the request. Business and
 * stock rules live in the service; this layer only maps HTTP ↔ service and
 * enforces the transport-level contract for idempotency on create.
 */

// Canonical UUID (v1–v8 / nil) — the Idempotency-Key must be a stable client id.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** POST /api/orders — customer — 201 (fresh) / 200 idempotent replay. */
const createOrder = asyncHandler(async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key || !key.trim()) {
    throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
  if (!UUID_RE.test(key.trim())) {
    throw ApiError.badRequest('Idempotency-Key must be a valid UUID', {
      'Idempotency-Key': 'expected a UUID',
    });
  }

  const result = await orderService.createOrder(req.user.id, req.body, req.user, key.trim());
  if (result.replay) {
    // A completed claim: replay the ORIGINAL body with an idempotent marker.
    res.status(200).json({ ...result.body, idempotent: true });
    return;
  }
  res.status(201).json(result.body);
});

/** GET /api/orders — customer (own) / staff (all) — 200 {data, meta}. */
const listOrders = asyncHandler(async (req, res) => {
  res.status(200).json(await orderService.listOrders(req.user, req.query));
});

/** GET /api/orders/:id — 200 full order (ownership enforced). */
const getOrder = asyncHandler(async (req, res) => {
  res.status(200).json(await orderService.getOrder(req.user, req.params.id));
});

/** GET /api/orders/:id/items — 200 order line snapshots. */
const getOrderItems = asyncHandler(async (req, res) => {
  res.status(200).json({ items: await orderService.getOrderItems(req.user, req.params.id) });
});

/** PATCH /api/orders/:id/status — staff — 200 updated order. */
const updateStatus = asyncHandler(async (req, res) => {
  res.status(200).json(await orderService.updateStatus(req.user, req.params.id, req.body));
});

/** POST /api/orders/:id/cancel — customer (own) or staff — 200 cancelled order. */
const cancelOrder = asyncHandler(async (req, res) => {
  res.status(200).json(await orderService.cancelOrder(req.user, req.params.id, req.body));
});

module.exports = {
  createOrder,
  listOrders,
  getOrder,
  getOrderItems,
  updateStatus,
  cancelOrder,
};
