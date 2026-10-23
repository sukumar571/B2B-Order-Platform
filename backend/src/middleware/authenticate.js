'use strict';

const userRepository = require('../repositories/user.repository');
const tokenService = require('../services/token.service');
const { ROLE_VALUES } = require('../constants/roles');
const { ApiError } = require('../utils/errors');

/**
 * Authentication middleware (FR-AUTH-04).
 * Validates the Bearer access token — signature, pinned HS256 algorithm,
 * expiry, issuer, audience and `typ` claim — then RE-LOADS the user so a
 * deactivated or deleted account cannot keep using a still-unexpired token
 * ("disabled users cannot authenticate" requirement).
 *
 * On success attaches `req.user` (public shape, no password_hash).
 * Failures are deliberately generic and identical for every rejection cause
 * so they cannot be used to enumerate users (safe, consistent errors).
 */

const UNAUTHENTICATED = {
  status: 401,
  code: 'UNAUTHENTICATED',
  message: 'Authentication required',
};

async function authenticate(req, _res, next) {
  try {
    const token = tokenService.extractBearer(req);
    if (!token)
      throw new ApiError(UNAUTHENTICATED.status, UNAUTHENTICATED.code, UNAUTHENTICATED.message);

    const payload = tokenService.verifyAccessToken(token);
    if (!tokenService.isAccessPayload(payload)) {
      throw new ApiError(UNAUTHENTICATED.status, UNAUTHENTICATED.code, UNAUTHENTICATED.message);
    }

    const user = await userRepository.findById(payload.sub);
    if (!user || !user.is_active) {
      throw new ApiError(UNAUTHENTICATED.status, UNAUTHENTICATED.code, UNAUTHENTICATED.message);
    }

    req.user = toAuthUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

/** The ONLY user shape allowed to leave the auth layer — hash stripped. */
function toAuthUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.is_active,
  };
}

/**
 * True when the caller holds the admin role — the escape hatch for
 * administrative access to another user's private data (auditable).
 */
function isAdmin(req) {
  return Boolean(req.user) && req.user.role === ROLE_VALUES.ADMIN;
}

/**
 * Non-rejecting variant of `authenticate` for PUBLIC read endpoints
 * (GET /api/products[/:id]). If a valid Bearer token is present the caller is
 * attached to `req.user` (so an admin can see inactive catalog items); any
 * missing/invalid token is treated as an anonymous caller and the request is
 * allowed to continue. It NEVER throws — a bad token simply means "no user".
 */
async function optionalAuthenticate(req, _res, next) {
  try {
    const token = tokenService.extractBearer(req);
    if (token) {
      const payload = tokenService.verifyAccessToken(token);
      if (tokenService.isAccessPayload(payload)) {
        const user = await userRepository.findById(payload.sub);
        if (user && user.is_active) req.user = toAuthUser(user);
      }
    }
  } catch {
    // Deliberately ignore: an invalid token just means an anonymous browse.
  }
  next();
}

module.exports = { authenticate, optionalAuthenticate, toAuthUser, isAdmin };
