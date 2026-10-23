'use strict';

const { withTransaction } = require('../db/pool');
const userRepository = require('../repositories/user.repository');
const { logAudit } = require('./audit.service');
const { ApiError } = require('../utils/errors');
const { ROLE_VALUES } = require('../constants/roles');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPE } = require('../constants/audit');
const {
  userListQuerySchema,
  userIdParamSchema,
  updateUserSchema,
  validateInput,
} = require('../utils/validators');

/**
 * Administrative user management (Phase 9 — "audit … administrative user changes
 * where applicable"). ADMIN only (enforced at the route). Two guardrails:
 *
 *  - SELF-LOCKOUT: an admin cannot demote themselves out of ADMIN or deactivate
 *    their own account — those would silently strand the only privileged actor.
 *  - The role/status UPDATE and its audit row commit in ONE transaction, so a
 *    permission change can never exist without its history entry (NFR-13).
 *
 * Only `role` and `is_active` are ever mutable here. Email/name/password are out
 * of scope for this endpoint by design (registration and self-service are the
 * identity surfaces); the strict schema rejects any other field.
 */

/** GET /api/users — admin directory (no password hash is ever selected). */
async function listUsers(rawQuery) {
  const q = validateInput(userListQuerySchema, rawQuery || {});
  const { rows, total } = await userRepository.listUsers({
    role: q.role ?? null,
    page: q.page,
    limit: q.limit,
  });
  return { data: rows, meta: { page: q.page, limit: q.limit, total } };
}

/** GET /api/users/:id — a single safe user record. */
async function getUser(rawId) {
  const { id } = validateInput(userIdParamSchema, { id: rawId });
  const user = await userRepository.findSafeById(id);
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
  return { data: user };
}

/** PATCH /api/users/:id — audited role / active-status change. */
async function updateUser(actor, rawId, rawBody) {
  const { id } = validateInput(userIdParamSchema, { id: rawId });
  const patch = validateInput(updateUserSchema, rawBody || {});

  const target = await userRepository.findSafeById(id);
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');

  const isSelf = String(actor.id) === String(target.id);
  const roleChanged = patch.role !== undefined && patch.role !== target.role;
  const statusChanged = patch.is_active !== undefined && patch.is_active !== target.is_active;

  if (isSelf && roleChanged) {
    throw new ApiError(
      409,
      'SELF_ROLE_CHANGE_NOT_ALLOWED',
      'You cannot change your own role — another admin must do so'
    );
  }
  if (isSelf && statusChanged && patch.is_active === false) {
    throw new ApiError(
      409,
      'SELF_DEACTIVATION_NOT_ALLOWED',
      'You cannot deactivate your own account'
    );
  }

  // A request that changes nothing is a no-op (returns the current row) and is
  // deliberately NOT audited — the trail records real state transitions only.
  if (!roleChanged && !statusChanged) return { data: target };

  const updated = await withTransaction(async (client) => {
    const row = await userRepository.updateUser(client, id, {
      role: roleChanged ? patch.role : null,
      isActive: statusChanged ? patch.is_active : null,
    });
    if (roleChanged) {
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: AUDIT_ENTITY_TYPE.USER,
        entityId: id,
        details: { from: target.role, to: patch.role },
      });
    }
    if (statusChanged) {
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
        entityType: AUDIT_ENTITY_TYPE.USER,
        entityId: id,
        details: { from: target.is_active, to: patch.is_active },
      });
    }
    return row;
  });

  return { data: updated };
}

module.exports = { listUsers, getUser, updateUser, ROLE_VALUES };
