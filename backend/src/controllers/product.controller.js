'use strict';

const productService = require('../services/product.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/** HTTP layer for the product catalog. Business rules live in the service. */

/** GET /api/products — 200 { data, meta }. */
const list = asyncHandler(async (req, res) => {
  const result = await productService.list(req.query, req.user);
  res.status(200).json(result);
});

/** GET /api/products/:id — 200 product object. */
const detail = asyncHandler(async (req, res) => {
  const { data } = await productService.getById(req.params.id, req.user);
  res.status(200).json(data);
});

/** POST /api/products — ADMIN only — 201 product object. */
const create = asyncHandler(async (req, res) => {
  const { data } = await productService.create(req.body, req.user);
  res.status(201).json(data);
});

/** PATCH /api/products/:id — ADMIN only — 200 updated product object. */
const update = asyncHandler(async (req, res) => {
  const { data } = await productService.update(req.params.id, req.body, req.user);
  res.status(200).json(data);
});

module.exports = { list, detail, create, update };
