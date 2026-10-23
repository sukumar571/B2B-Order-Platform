'use strict';

const { ApiError } = require('../utils/errors');
const { normalizeRole } = require('../constants/roles');

/**
 * Reusable role-authorization middleware factory (FR-AUTH-05).
 *
 *   router.get('/admin-only', authenticate, authorize('ADMIN'), handler)
 *   router.get('/staff', authenticate, authorize('ADMIN', 'ORDER_MANAGER'), handler)
 *
 * Accepts both public aliases (ADMIN, ORDER_MANAGER) and canonical DB values
 * (admin, agent). Must run AFTER authenticate (uses req.user).
 * A role that is unknown to the system is a programming error → thrown at
 * wiring time, not per request.
 */
function authorize(...allowedRoles) {
  const allowed = new Set(allowedRoles.map((r) => normalizeRole(r)).filter(Boolean));
  if (allowed.size === 0) {
    throw new Error(`authorize(): no valid roles in ${JSON.stringify(allowedRoles)}`);
  }
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'UNAUTHENTICATED', 'Authentication required'));
    }
    if (!allowed.has(req.user.role)) {
      return next(
        new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action')
      );
    }
    return next();
  };
}

/**
 * Ownership guard factory — protects one user's private data from another
 * user (IDOR defence; horizontal-privilege-escalation requirement).
 *
 *   router.get('/carts', requireSelf, handler)      // self-scoped: identity
 *                                                    // comes from the token only
 *   router.get('/x', requireOwnership(o => o.ownerUserId), handler)
 *
 * `extractOwnerId(req)` must return the resource's owning user id, or null
 * when the resource does not exist (then 404, never 403 — do not leak
 * existence). Set `allowAdmin: true` to let admins bypass ownership checks
 * for administrative access (such calls should be audited by the service).
 */
function requireOwnership(extractOwnerId, { allowAdmin = false } = {}) {
  return async (req, _res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
      const ownerId = await extractOwnerId(req);
      if (ownerId === null || ownerId === undefined) {
        throw ApiError.notFound('Resource not found');
      }
      const isOwner = String(ownerId) === String(req.user.id);
      if (!isOwner && !(allowAdmin && req.user.role === 'admin')) {
        throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this resource');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Self-scoped guard: endpoints whose notion of "whose data" is purely the
 * authenticated identity — there is no user id in the request to forge.
 * (Documented pattern for Phase 5+ endpoints like /api/users/:id/... where
 * the :id must be compared against req.user instead.)
 */
function requireSelf(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED', 'Authentication required'));
  return next();
}

module.exports = { authorize, requireOwnership, requireSelf };
