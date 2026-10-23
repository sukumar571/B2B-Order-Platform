'use strict';

const userService = require('../services/user.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * HTTP layer for administrative user management — ADMIN only (route enforced).
 * Reads return the safe user shape (no password_hash); the only write is the
 * audited role/status PATCH. There is NO create-here path: registration is the
 * public CUSTOMER-only flow under /api/auth.
 */

/** GET /api/users — 200 { data, meta }. */
const listUsers = asyncHandler(async (req, res) => {
  res.status(200).json(await userService.listUsers(req.query));
});

/** GET /api/users/:id — 200 { data }. */
const getUser = asyncHandler(async (req, res) => {
  res.status(200).json(await userService.getUser(req.params.id));
});

/** PATCH /api/users/:id — 200 updated safe user (audited; self-lockout guarded). */
const updateUser = asyncHandler(async (req, res) => {
  res.status(200).json(await userService.updateUser(req.user, req.params.id, req.body));
});

module.exports = { listUsers, getUser, updateUser };
