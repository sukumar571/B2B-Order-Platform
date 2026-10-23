'use strict';

const inventoryService = require('../services/inventory.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/** HTTP layer for inventory. */

/** GET /api/inventory — ADMIN / ORDER_MANAGER — 200 { data, meta }. */
const list = asyncHandler(async (req, res) => {
  const result = await inventoryService.list(req.query);
  res.status(200).json(result);
});

/** GET /api/inventory/low-stock — ADMIN / ORDER_MANAGER — 200 { data, meta }. */
const lowStock = asyncHandler(async (req, res) => {
  const result = await inventoryService.lowStock(req.query);
  res.status(200).json(result);
});

/** PATCH /api/inventory/:id — ADMIN only — 200 { data, movement }. */
const adjust = asyncHandler(async (req, res) => {
  const result = await inventoryService.adjust(req.params.id, req.body, req.user);
  res.status(200).json(result);
});

module.exports = { list, lowStock, adjust };
