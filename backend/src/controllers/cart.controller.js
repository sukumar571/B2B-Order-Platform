'use strict';

const cartService = require('../services/cart.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * HTTP layer for the shopping cart. The cart owner is read ONLY from the
 * authenticated user (`req.user.id`) — never from a path/body parameter, so a
 * client can never address another customer's cart. All business rules live in
 * the service.
 */

/** GET /api/cart — customer — 200 cart object (server-derived totals). */
const getCart = asyncHandler(async (req, res) => {
  const cart = await cartService.getCart(req.user.id);
  res.status(200).json(cart);
});

/** POST /api/cart/items — customer — 201 updated cart object. */
const addItem = asyncHandler(async (req, res) => {
  const cart = await cartService.addItem(req.user.id, req.body, req.user);
  res.status(201).json(cart);
});

/** PATCH /api/cart/items/:itemId — customer — 200 updated cart object. */
const updateItem = asyncHandler(async (req, res) => {
  const cart = await cartService.updateItem(req.user.id, req.params.itemId, req.body, req.user);
  res.status(200).json(cart);
});

/** DELETE /api/cart/items/:itemId — customer — 200 updated cart object. */
const removeItem = asyncHandler(async (req, res) => {
  const cart = await cartService.removeItem(req.user.id, req.params.itemId, req.user);
  res.status(200).json(cart);
});

/** DELETE /api/cart — customer — 204 (cart emptied). */
const clearCart = asyncHandler(async (req, res) => {
  await cartService.clearCart(req.user.id, req.user);
  res.status(204).send();
});

module.exports = { getCart, addItem, updateItem, removeItem, clearCart };
