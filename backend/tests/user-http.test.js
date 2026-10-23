'use strict';

/**
 * Phase 9 — administrative user-management integration tests (isolated test DB).
 *
 * Covers: ADMIN-only access to the directory, the audited role / active-status
 * PATCH (transactional — a USER_ROLE_CHANGED row lands with the change), the
 * self-lockout guardrails, that deactivating an account blocks the next login
 * (recorded as ACCOUNT_DISABLED_ATTEMPT / failure), strict-schema rejection of
 * any other field (no email/name/password via this surface), and that the
 * response never leaks a password hash.
 */

process.env.NODE_ENV = 'test';

const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const config = require('../src/config/env');
const db = require('../src/db/pool');
const pm = require('node-pg-migrate');
const migrate = pm.default || pm.migrate || pm;
const { createApp } = require('../src/app');
const tokenService = require('../src/services/token.service');

const ENABLED = Boolean(config.databaseUrlTest) && process.env.B2B_RUN_DB_TESTS === '1';
const SKIP_REASON = ENABLED ? false : 'isolated test DB required — run: npm run test:integration';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
function runMigrations(direction) {
  return migrate({
    direction,
    databaseUrl: config.databaseUrlTest,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    verbose: false,
    log: () => {},
  });
}

let seq = 0;
const U = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

const app = createApp();

async function makeUser(role = 'customer') {
  const email = `${role}-${U()}.user.test`;
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, '$2b$12$notarealhashnotarealhashnotarealhashnotareah', $2, $3)
     RETURNING id`,
    [email, `User ${role}`, role]
  );
  const id = r.rows[0].id;
  const token = tokenService.signAccessToken({ userId: id, role });
  return { id, email, token };
}

const patch = (token, id, body) =>
  request(app).patch(`/api/users/${id}`).set('Authorization', `Bearer ${token}`).send(body);

async function actionsFor(token, entityId) {
  const res = await request(app)
    .get(`/api/audit-logs?entity_type=user&entity_id=${entityId}&limit=100`)
    .set('Authorization', `Bearer ${token}`);
  return res.body.data.map((r) => r.action);
}

describe(
  'Administrative user management over HTTP (isolated test DB)',
  {
    skip: SKIP_REASON,
    timeout: 240000,
  },
  () => {
    let admin;
    let agent;
    let customer;

    before(async () => {
      await runMigrations('up');
      await db.getPool().query('SELECT 1');
      admin = await makeUser('admin');
      agent = await makeUser('agent');
      customer = await makeUser('customer');
    });

    after(async () => {
      await db.closePool();
    });

    test('the directory is ADMIN-only', async () => {
      assert.strictEqual((await request(app).get('/api/users')).status, 401);
      assert.strictEqual(
        (await request(app).get('/api/users').set('Authorization', `Bearer ${customer.token}`))
          .status,
        403
      );
      assert.strictEqual(
        (await request(app).get('/api/users').set('Authorization', `Bearer ${agent.token}`)).status,
        403
      );
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${admin.token}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.meta && typeof res.body.meta.total === 'number');
      // No password material is ever serialized.
      assert.ok(
        res.body.data.every((u) => !('password_hash' in u) && !('password' in u)),
        'users list never carries a password hash'
      );
    });

    test('an admin role change is applied and audited transactionally', async () => {
      const target = await makeUser('customer');
      const res = await patch(admin.token, target.id, { role: 'agent' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.data.role, 'agent');

      const actions = await actionsFor(admin.token, target.id);
      assert.ok(actions.includes('USER_ROLE_CHANGED'), 'role change audited');

      const row = await db.query(
        'SELECT action, details, outcome FROM audit_logs WHERE entity_type=$1 AND entity_id=$2 AND action=$3',
        ['user', target.id, 'USER_ROLE_CHANGED']
      );
      assert.strictEqual(row.rows[0].details.from, 'customer');
      assert.strictEqual(row.rows[0].details.to, 'agent');
      assert.strictEqual(row.rows[0].outcome, 'success');
    });

    test('self-lockout: an admin cannot demote or deactivate their own account', async () => {
      const demote = await patch(admin.token, admin.id, { role: 'customer' });
      assert.strictEqual(demote.status, 409);
      assert.strictEqual(demote.body.error.code, 'SELF_ROLE_CHANGE_NOT_ALLOWED');

      const deactivateSelf = await patch(admin.token, admin.id, { is_active: false });
      assert.strictEqual(deactivateSelf.status, 409);
      assert.strictEqual(deactivateSelf.body.error.code, 'SELF_DEACTIVATION_NOT_ALLOWED');
    });

    test('deactivating an account blocks its next login (audited as a failure)', async () => {
      // A real, login-capable account created via public registration.
      const email = `deact-${U()}@user.test`;
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'Passw0rd!123', name: 'Deactivate Me' });
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      const id = reg.body.user.id;

      // Confirm login works while active.
      assert.strictEqual(
        (await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!123' }))
          .status,
        200
      );

      // Admin deactivates it.
      const off = await patch(admin.token, id, { is_active: false });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      assert.strictEqual(off.body.data.is_active, false);

      // Login is now refused (403) and recorded as a disabled-account failure.
      const blocked = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'Passw0rd!123' });
      assert.strictEqual(blocked.status, 403);
      assert.strictEqual(blocked.body.error.code, 'ACCOUNT_DISABLED');

      const actions = await actionsFor(admin.token, id);
      assert.ok(actions.includes('USER_STATUS_CHANGED'), 'status change audited');
      const disabledAttempts = await request(app)
        .get('/api/audit-logs?action=ACCOUNT_DISABLED_ATTEMPT&outcome=failure&limit=100')
        .set('Authorization', `Bearer ${admin.token}`);
      assert.ok(disabledAttempts.body.data.some((r) => r.entity_id === String(id)));
    });

    test('strict PATCH: unknown fields and no-op bodies are rejected; unknown id 404s', async () => {
      const target = await makeUser('customer');
      const withEmail = await patch(admin.token, target.id, { email: 'x@y.test' });
      assert.strictEqual(withEmail.status, 400, 'cannot edit email via this endpoint');

      const empty = await patch(admin.token, target.id, {});
      assert.strictEqual(empty.status, 400, 'at least one field required');

      const missing = await patch(admin.token, '999999999', { role: 'agent' });
      assert.strictEqual(missing.status, 404);
      assert.strictEqual(missing.body.error.code, 'USER_NOT_FOUND');

      // Customer cannot PATCH at all.
      assert.strictEqual((await patch(customer.token, target.id, { role: 'agent' })).status, 403);
    });
  }
);
