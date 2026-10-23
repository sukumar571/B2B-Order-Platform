'use strict';

/**
 * Audit trail writer (FR-AUD-01/02/05).
 *
 * Every auditable business mutation calls `logAudit` with the SAME transaction
 * client that performed the change, so the data write and its history row
 * commit or roll back together (NFR-13). audit_logs is append-only at the DB
 * level (BEFORE UPDATE/DELETE trigger), so there is no update/delete path here.
 *
 * `details` must be a small, explicitly-built object — never passwords, JWTs,
 * or full row snapshots (R-06). Callers pass only whitelisted fields.
 */

const { AUDIT_OUTCOME, isValidOutcome, isValidAction } = require('../constants/audit');
const auditRepository = require('../repositories/audit.repository');
const { auditListQuerySchema, validateInput } = require('../utils/validators');

const VALID_ACTIONS_PREFIX = /^[A-Z][A-Z0-9_]{1,59}$/;

/**
 * @param {object} client      pg client/pool (must expose .query)
 * @param {object} entry
 * @param {number|string|null} entry.actorId     users.id (null for system/anonymous)
 * @param {string|null} entry.actorRole          admin | agent | customer | null
 * @param {string} entry.action                   e.g. 'PRODUCT_CREATED'
 * @param {string} entry.entityType               e.g. 'product' | 'inventory'
 * @param {number|string|null} entry.entityId
 * @param {object} [entry.details]                JSONB payload (safe keys only)
 * @param {string} [entry.outcome]                'success' (default) | 'failure'
 */
async function logAudit(
  client,
  {
    actorId = null,
    actorRole = null,
    action,
    entityType,
    entityId = null,
    details = {},
    outcome = AUDIT_OUTCOME.SUCCESS,
  }
) {
  if (!action || !VALID_ACTIONS_PREFIX.test(action)) {
    throw new Error(`logAudit: invalid action "${action}"`);
  }
  // Fail loudly in tests when a caller invents an action outside the registry
  // (the completeness matrix relies on constants/audit.js being exhaustive).
  if (process.env.NODE_ENV === 'test' && !isValidAction(action)) {
    throw new Error(`logAudit: unregistered action "${action}"`);
  }
  if (!entityType) {
    throw new Error('logAudit: entityType is required');
  }
  if (!isValidOutcome(outcome)) {
    throw new Error(`logAudit: invalid outcome "${outcome}"`);
  }
  await client.query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, details, outcome)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [actorId, actorRole, action, entityType, entityId, JSON.stringify(details || {}), outcome]
  );
}

/**
 * Admin read query (FR-AUD-03). Route-level ADMIN authorization is the ONLY
 * gate — there is no self-scoping because the whole trail is admin-visible, and
 * NO ordinary role may read it (a customer or agent is refused before this
 * runs). There is no write path here: the trail is append-only (FR-AUD-02).
 */
async function listForAdmin(rawQuery) {
  const q = validateInput(auditListQuerySchema, rawQuery || {});
  const { rows, total } = await auditRepository.listAuditLogs(
    {
      actorId: q.actor_id,
      action: q.action,
      entityType: q.entity_type,
      entityId: q.entity_id,
      outcome: q.outcome,
      from: q.from,
      to: q.to,
    },
    { page: q.page, limit: q.limit }
  );
  return { data: rows, meta: { page: q.page, limit: q.limit, total } };
}

module.exports = { logAudit, listForAdmin };
