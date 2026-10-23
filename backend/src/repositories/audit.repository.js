'use strict';

/**
 * Read-only data access for `audit_logs` (Phase 9 — FR-AUD-02/03).
 *
 * There is DELIBERATELY no insert/update/delete helper here: audit rows are
 * written only by `audit.service.logAudit` inside each business transaction,
 * and the table is append-only at the DB level (a BEFORE UPDATE/DELETE trigger
 * forbids mutation — migration 11), so ordinary users — and even admins through
 * the API — cannot modify or delete history (FR-AUD-02). This module can only
 * READ, and only ever behind the ADMIN authorization gate.
 *
 * All filters are parameterized (no interpolation — C-04). Date filters are
 * ISO-8601 timestamps validated upstream; we bind them as `$n::timestamptz`.
 */

const { query } = require('../db/pool');

// Actor identity is joined so the admin viewer can name the person, not just
// the id. It is a LEFT JOIN: failed logins have no actor_id (still shown).
const SELECT = `
  a.id, a.actor_id, a.actor_role, a.action, a.entity_type, a.entity_id,
  a.details, a.outcome, a.created_at,
  u.email AS actor_email, u.name AS actor_name`;

const FROM = `FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id`;

function mapAuditLog(row) {
  return {
    id: String(row.id),
    actor_id: row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id),
    actor_role: row.actor_role,
    actor_email: row.actor_email || null,
    actor_name: row.actor_name || null,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id === null || row.entity_id === undefined ? null : String(row.entity_id),
    details: row.details,
    outcome: row.outcome,
    created_at: row.created_at,
  };
}

function buildWhere({ actorId, action, entityType, entityId, outcome, from, to }) {
  const clauses = [];
  const args = [];
  const add = (sql, value) => {
    args.push(value);
    clauses.push(sql.replace('?', `$${args.length}`));
  };
  if (actorId !== undefined && actorId !== null) add('a.actor_id = ?', actorId);
  if (action) add('a.action = ?', action);
  if (entityType) add('a.entity_type = ?', entityType);
  if (entityId !== undefined && entityId !== null) add('a.entity_id = ?', entityId);
  if (outcome) add('a.outcome = ?', outcome);
  if (from) add('a.created_at >= ?::timestamptz', from);
  if (to) add('a.created_at <= ?::timestamptz', to);
  return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/**
 * Paginated audit query for admins. Newest first. `limit` is already clamped
 * upstream (1..100). Returns { rows, total } for the meta envelope.
 */
async function listAuditLogs(filters, { page, limit }) {
  const { whereSql, args } = buildWhere(filters);

  const countRes = await query(`SELECT count(*)::int AS total ${FROM} ${whereSql}`, args);
  const total = countRes.rows[0].total;

  const dataArgs = args.concat([limit, (page - 1) * limit]);
  const dataRes = await query(
    `SELECT ${SELECT} ${FROM} ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    dataArgs
  );
  return { rows: dataRes.rows.map(mapAuditLog), total };
}

/** The most recent `limit` audit events (dashboard activity feed; ADMIN only). */
async function recentAuditLogs(limit) {
  const r = await query(`SELECT ${SELECT} ${FROM} ORDER BY a.created_at DESC, a.id DESC LIMIT $1`, [
    limit,
  ]);
  return r.rows.map(mapAuditLog);
}

/** Total rows in the trail — a small honest "events recorded" dashboard metric. */
async function countAll() {
  const r = await query('SELECT count(*)::int AS total FROM audit_logs');
  return r.rows[0].total;
}

module.exports = { listAuditLogs, recentAuditLogs, countAll, mapAuditLog };
