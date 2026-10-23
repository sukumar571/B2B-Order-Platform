'use strict';

/**
 * Data access for `users` — parameterized SQL only (C-04).
 * Rows returned here contain password_hash; it is stripped at the service
 * boundary (toPublicUser) and must never reach a response or a log (R-06).
 */

const { query } = require('../db/pool');

const COLUMNS = 'id, email, password_hash, name, role, is_active, created_at, updated_at';

async function findByEmail(email) {
  const r = await query(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]);
  return r.rows[0] || null;
}

async function findById(id) {
  const r = await query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

/**
 * Insert a brand-new account. `role` is NOT client-controlled: the service
 * layer hard-codes 'customer' for public registration (FR-AUTH-05).
 * A duplicate email surfaces as PostgreSQL error 23505 (users_email_uq).
 */
async function createUser({ email, passwordHash, name, role }) {
  const r = await query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [email, passwordHash, name, role]
  );
  return r.rows[0];
}

async function emailExists(email) {
  const r = await query('SELECT 1 FROM users WHERE email = $1', [email]);
  return r.rowCount > 0;
}

// ── Administrative user management (Phase 9 — ADMIN only) ────────────────────
// SAFE columns: password_hash is NEVER selected here, so the admin list/update
// paths cannot leak it even accidentally (R-06).
const SAFE_COLUMNS = 'id, email, name, role, is_active, created_at, updated_at';

function mapSafeUser(row) {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Paginated admin directory listing (newest first). Optional role filter. */
async function listUsers({ role = null, page, limit }) {
  const clauses = [];
  const args = [];
  if (role) {
    args.push(role);
    clauses.push(`role = $${args.length}`);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countRes = await query(`SELECT count(*)::int AS total FROM users ${whereSql}`, args);
  const total = countRes.rows[0].total;

  const dataArgs = args.concat([limit, (page - 1) * limit]);
  const dataRes = await query(
    `SELECT ${SAFE_COLUMNS} FROM users ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    dataArgs
  );
  return { rows: dataRes.rows.map(mapSafeUser), total };
}

/** Load one user by id WITHOUT the password hash (safe shape). */
async function findSafeById(id) {
  const r = await query(`SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1`, [id]);
  return r.rows[0] ? mapSafeUser(r.rows[0]) : null;
}

/**
 * Apply an admin role/status change. Runs on the SERVICE's transaction client
 * so the UPDATE and its audit row commit together (NFR-13). Only role / is_active
 * are ever written; a null field means "leave unchanged".
 */
async function updateUser(client, id, { role = null, isActive = null }) {
  const r = await client.query(
    `UPDATE users
        SET role = COALESCE($2, role),
            is_active = COALESCE($3, is_active),
            updated_at = now()
      WHERE id = $1
      RETURNING ${SAFE_COLUMNS}`,
    [id, role, isActive]
  );
  return r.rows[0] ? mapSafeUser(r.rows[0]) : null;
}

module.exports = {
  findByEmail,
  findById,
  createUser,
  emailExists,
  listUsers,
  findSafeById,
  updateUser,
  mapSafeUser,
};
