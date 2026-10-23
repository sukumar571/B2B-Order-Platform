'use strict';

process.env.NODE_ENV = 'test';

const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../src/config/env');
const db = require('../src/db/pool');
const pm = require('node-pg-migrate');
const migrate = pm.default || pm.migrate || pm;
const { createApp } = require('../src/app');
const { authenticate } = require('../src/middleware/authenticate');
const { authorize, requireOwnership, requireSelf } = require('../src/middleware/authorize');
const { errorHandler } = require('../src/middleware/errorHandler');

// Opt-in gate identical to db-integration.test.js: plain `npm test` must
// never require a database.
const ENABLED = Boolean(config.databaseUrlTest) && process.env.B2B_RUN_DB_TESTS === '1';
const SKIP_REASON = ENABLED
  ? false
  : 'isolated test DB required — run: npm run test:integration (uses DATABASE_URL_TEST only)';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function runMigrations(direction, count) {
  return migrate({
    direction,
    databaseUrl: config.databaseUrlTest,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    ...(count === undefined ? {} : { count }),
    verbose: false,
    log: () => {},
  });
}

let seq = 0;
const U = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const PASSWORD = 'Str0ngPassw0rd';
const email = (tag = 'u') => `${tag}-${U()}@auth.test`;

// Per-test rate-limit buckets (see middleware/rateLimit.js keyGenerator):
// every test gets a fresh IP-equivalent bucket so registrations inside tests
// never share a window with each other.
const app = createApp();
let bucketSeq = 0;
const nextBucket = () => `bucket-${Date.now()}-${bucketSeq++}`;

/** Extract the refresh_token cookie value from a Set-Cookie header array. */
function refreshCookie(res) {
  const headers = res.headers['set-cookie'] || [];
  const hit = headers.find((c) => c.startsWith('refresh_token='));
  return hit ? hit.split(';')[0].slice('refresh_token='.length) : undefined;
}

/** Register a throwaway customer and return { email, password, accessToken, cookie }. */
async function newCustomer(tag = 'cust', password = PASSWORD, bucket = nextBucket()) {
  const payload = { email: email(tag), password, name: `Test ${tag}` };
  const res = await request(app)
    .post('/api/auth/register')
    .set('X-Test-Bucket', bucket)
    .send(payload);
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return { ...payload, password, accessToken: res.body.accessToken, cookie: refreshCookie(res) };
}

/**
 * Probe router exercising the reusable authorization middlewares — the same
 * composition Phase 5 modules will use (role gates + cross-user protection).
 */
function probeApp() {
  const probe = express();
  probe.use(express.json());
  probe.get('/admin-only', authenticate, authorize('ADMIN'), (_req, res) => res.json({ ok: true }));
  probe.get('/staff', authenticate, authorize('ADMIN', 'ORDER_MANAGER'), (_req, res) =>
    res.json({ ok: true })
  );
  probe.get('/secret', authenticate, requireSelf, (req, res) =>
    // "Private data" is addressed ONLY by req.user.id — nothing to forge.
    res.json({ viewer: req.user.id })
  );
  probe.get(
    '/other/:ownerId',
    authenticate,
    requireOwnership(async (req) => req.params.ownerId),
    (req, res) => res.json({ ok: true })
  );
  probe.use(errorHandler);
  return probe;
}

describe(
  'Authentication over HTTP (isolated test DB)',
  { skip: SKIP_REASON, timeout: 180000 },
  () => {
    before(async () => {
      await runMigrations('up');
      await db.getPool().query('SELECT 1');
    });

    after(async () => {
      await db.closePool();
    });

    // ── Registration ─────────────────────────────────────────────────────────

    test('POST /api/auth/register creates a CUSTOMER only, hashing the password', async () => {
      const creds = { email: email('reg'), password: PASSWORD, name: 'Rex Register' };
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-Test-Bucket', nextBucket())
        .send(creds);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.user.role, 'customer');
      assert.strictEqual(res.body.user.email, creds.email);
      assert.ok(res.body.accessToken, 'access token returned');
      assert.ok(res.body.user.id, 'user id returned');

      const stored = await db.query('SELECT password_hash, role FROM users WHERE email = $1', [
        creds.email,
      ]);
      assert.match(stored.rows[0].password_hash, /^\$2[aby]\$\d{2}\$/, 'bcrypt hash stored');
      assert.ok(!JSON.stringify(stored.rows[0].password_hash).includes(creds.password));

      // A default cart was created atomically with the user.
      const carts = await db.query(
        `SELECT c.id FROM carts c JOIN users u ON u.id = c.customer_id WHERE u.email = $1`,
        [creds.email]
      );
      assert.strictEqual(carts.rowCount, 1, 'default cart created with the account');
    });

    test('registration can NEVER select ADMIN or ORDER_MANAGER', async () => {
      const bucket = nextBucket();
      for (const role of ['ADMIN', 'admin', 'ORDER_MANAGER', 'agent']) {
        const res = await request(app)
          .post('/api/auth/register')
          .set('X-Test-Bucket', bucket)
          .send({ email: email('esc'), password: PASSWORD, name: 'Eve Scalar', role });
        assert.strictEqual(res.status, 400, `role=${role} must be rejected`);
        assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
      }
    });

    test('duplicate emails are rejected with 409 EMAIL_TAKEN (case-insensitive)', async () => {
      const bucket = nextBucket();
      const creds = { email: email('dup'), password: PASSWORD, name: 'Dup User' };
      const first = await request(app)
        .post('/api/auth/register')
        .set('X-Test-Bucket', bucket)
        .send(creds);
      assert.strictEqual(first.status, 201);
      const second = await request(app)
        .post('/api/auth/register')
        .set('X-Test-Bucket', bucket)
        .send({ ...creds, email: creds.email.toUpperCase() });
      assert.strictEqual(second.status, 409);
      assert.strictEqual(second.body.error.code, 'EMAIL_TAKEN');
    });

    test('invalid registration input yields 400 VALIDATION_ERROR without echoing secrets', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-Test-Bucket', nextBucket())
        .send({ email: 'not-an-email', password: 'sh0rt', name: '' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
      assert.ok(!JSON.stringify(res.body).includes('sh0rt'), 'response leaks password');
      assert.ok(res.body.error.details.email, 'field-level details present');
    });

    // ── Login ────────────────────────────────────────────────────────────────

    test('POST /api/auth/login succeeds and sets a hardened HttpOnly cookie', async () => {
      const creds = await newCustomer('log');
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: creds.email, password: creds.password });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user.role, 'customer');
      assert.ok(res.body.accessToken);
      assert.ok(!('refreshToken' in res.body), 'refresh token never in the body');

      const raw = res.headers['set-cookie'].find((c) => c.startsWith('refresh_token='));
      assert.match(raw, /HttpOnly/i, 'cookie is HttpOnly');
      assert.match(raw, /SameSite=Strict/i, 'cookie is SameSite=strict (CSRF defence)');
      assert.match(raw, /Path=\/api\/auth/i, 'cookie scoped to /api/auth');
      assert.ok(!JSON.stringify(res.body).includes('$2'), 'no bcrypt hash in response');
    });

    test('wrong password and unknown email return the identical safe 401', async () => {
      const creds = await newCustomer('wrong');
      const bucket = nextBucket();
      const bad = await request(app)
        .post('/api/auth/login')
        .set('X-Test-Bucket', bucket)
        .send({ email: creds.email, password: 'Wr0ngPassword!' });
      const ghost = await request(app)
        .post('/api/auth/login')
        .set('X-Test-Bucket', bucket)
        .send({ email: email('ghost'), password: 'Wr0ngPassword!' });
      assert.strictEqual(bad.status, 401);
      assert.strictEqual(ghost.status, 401);
      assert.strictEqual(bad.body.error.message, ghost.body.error.message);
      assert.strictEqual(bad.body.error.code, 'INVALID_CREDENTIALS');
      assert.ok(!/password|hash/i.test(JSON.stringify(bad.body.error.details || {})));
    });

    test('disabled accounts cannot log in (403 ACCOUNT_DISABLED)', async () => {
      const creds = await newCustomer('dis');
      await db.query('UPDATE users SET is_active = false WHERE email = $1', [creds.email]);
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: creds.email, password: creds.password });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'ACCOUNT_DISABLED');
    });

    // ── Refresh / logout lifecycle ──────────────────────────────────────────

    test('refresh rotates the cookie; reusing a spent token kills the family', async () => {
      const creds = await newCustomer('rot');
      const r1 = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${creds.cookie}`);
      assert.strictEqual(r1.status, 200);
      const cookie2 = refreshCookie(r1);
      assert.ok(cookie2 && cookie2 !== creds.cookie, 'a NEW refresh token is issued (rotation)');

      // The old (spent) token now counts as reuse: whole family revoked.
      const reuse = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${creds.cookie}`);
      assert.strictEqual(reuse.status, 401);
      assert.strictEqual(reuse.body.error.code, 'TOKEN_REUSED');

      // …including the previously rotated-out successor.
      const after = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${cookie2}`);
      assert.strictEqual(after.status, 401, 'family revocation must have killed the successor too');
    });

    test('logout clears the cookie and revokes the family', async () => {
      const creds = await newCustomer('out');
      const out = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `refresh_token=${creds.cookie}`);
      assert.strictEqual(out.status, 200);
      const cleared = out.headers['set-cookie'].find((c) => c.startsWith('refresh_token='));
      assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/i, 'cookie cleared');

      const renewed = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${creds.cookie}`);
      assert.strictEqual(renewed.status, 401, 'revoked token must not refresh after logout');
    });

    test('garbage or missing refresh cookies fail safely with 401', async () => {
      const junk = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=la.la.la');
      assert.strictEqual(junk.status, 401);
      assert.strictEqual(junk.body.error.code, 'INVALID_REFRESH_TOKEN');
      const none = await request(app).post('/api/auth/refresh');
      assert.strictEqual(none.status, 401);
    });

    // ── GET /api/auth/me + token validation ─────────────────────────────────

    test('GET /api/auth/me returns the hash-free profile of the Bearer identity', async () => {
      const creds = await newCustomer('me');
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${creds.accessToken}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user.email, creds.email);
      assert.ok(!JSON.stringify(res.body).includes('$2'), 'no password hash anywhere');
      assert.ok(!('password' in res.body.user) && !('passwordHash' in res.body.user));
    });

    test('missing, malformed, forged, expired, alg:none, and refresh-type bearer tokens all 401', async () => {
      const creds = await newCustomer('tok');
      const authed = { Authorization: `Bearer ${creds.accessToken}` };
      assert.strictEqual((await request(app).get('/api/auth/me')).status, 401);
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status,
        401
      );
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set(authed).query({ x: 1 })).status,
        200
      );

      const forged = jwt.sign(
        { sub: '1', typ: 'access', role: 'admin' },
        'attacker-secret-attacker-secret',
        {
          algorithm: 'HS256',
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
          expiresIn: '5m',
        }
      );
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status,
        401,
        'forged signature accepted'
      );

      const expired = jwt.sign(
        { sub: '1', typ: 'access', role: 'customer' },
        config.jwtAccessSecret,
        {
          algorithm: 'HS256',
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
          expiresIn: '-10s',
        }
      );
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).status,
        401,
        'expired token accepted'
      );

      const none = jwt.sign({ sub: '1', typ: 'access' }, '', { algorithm: 'none' });
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${none}`)).status,
        401,
        'alg:none accepted'
      );

      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${creds.cookie}`))
          .status,
        401,
        'refresh envelope accepted as bearer token'
      );

      // Every rejection uses the same safe, generic envelope.
      const miss = await request(app).get('/api/auth/me');
      assert.strictEqual(miss.body.error.code, 'UNAUTHENTICATED');
    });

    test('a disabled user is rejected even with a still-valid access token', async () => {
      const creds = await newCustomer('banned');
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${creds.accessToken}`))
          .status,
        200
      );
      await db.query('UPDATE users SET is_active = false WHERE email = $1', [creds.email]);
      assert.strictEqual(
        (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${creds.accessToken}`))
          .status,
        401,
        'disabled user kept access'
      );
    });

    // ── RBAC + cross-user data protection (probe composition) ───────────────

    test('role middleware: customer 403s admin routes, staff routes admit agent/admin', async () => {
      const probe = probeApp();
      const cust = await newCustomer('rbac-c');
      const agent = await newCustomer('rbac-a');
      const admin = await newCustomer('rbac-ad');
      await db.query(`UPDATE users SET role = 'agent' WHERE email = $1`, [agent.email]);
      await db.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [admin.email]);

      for (const [who, token, expected] of [
        ['customer', cust.accessToken, 403],
        ['agent', agent.accessToken, 403],
        ['admin', admin.accessToken, 200],
      ]) {
        const res = await request(probe).get('/admin-only').set('Authorization', `Bearer ${token}`);
        assert.strictEqual(res.status, expected, `${who} on /admin-only`);
        if (expected === 403) assert.strictEqual(res.body.error.code, 'FORBIDDEN');
      }
      // staff route: agent + admin pass, customer still 403; no token 401s.
      assert.strictEqual(
        (await request(probe).get('/staff').set('Authorization', `Bearer ${agent.accessToken}`))
          .status,
        200
      );
      assert.strictEqual(
        (await request(probe).get('/staff').set('Authorization', `Bearer ${cust.accessToken}`))
          .status,
        403
      );
      assert.strictEqual((await request(probe).get('/staff')).status, 401);
    });

    test('users cannot reach another user’s private data (self-scope + ownership)', async () => {
      const probe = probeApp();
      const alice = await newCustomer('alice');
      const bob = await newCustomer('bob');
      const aliceId = (await db.query('SELECT id FROM users WHERE email = $1', [alice.email]))
        .rows[0].id;

      // Self-scoped endpoint always addresses the caller — nothing to tamper with.
      const a = await request(probe)
        .get('/secret')
        .set('Authorization', `Bearer ${alice.accessToken}`);
      const b = await request(probe)
        .get('/secret')
        .set('Authorization', `Bearer ${bob.accessToken}`);
      assert.strictEqual(a.body.viewer, String(aliceId));
      assert.notStrictEqual(b.body.viewer, String(aliceId));

      // Ownership-guarded endpoint: stranger 403s, owner passes, 401 without a token.
      assert.strictEqual(
        (
          await request(probe)
            .get(`/other/${aliceId}`)
            .set('Authorization', `Bearer ${bob.accessToken}`)
        ).status,
        403
      );
      assert.strictEqual(
        (
          await request(probe)
            .get(`/other/${aliceId}`)
            .set('Authorization', `Bearer ${alice.accessToken}`)
        ).status,
        200
      );
      assert.strictEqual((await request(probe).get(`/other/${aliceId}`)).status, 401);
    });

    // ── Rate limiting (enforced via B2B_ENFORCE_RATE_LIMIT=1 from the runner) ──

    test('repeated wrong logins hit 429 RATE_LIMITED with envelope + headers', async () => {
      const creds = await newCustomer('rl');
      const bucket = nextBucket(); // ALL attempts share one bucket on purpose
      const attempts = config.authRateMax + 2;
      let limited = null;
      for (let i = 0; i < attempts; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .set('X-Test-Bucket', bucket)
          .send({ email: creds.email, password: `Wr0ngPassword${i}` });
        if (res.status === 429) {
          limited = res;
          break;
        }
      }
      assert.ok(
        limited,
        `429 never arrived within ${attempts} attempts (AUTH_RATE_MAX=${config.authRateMax})`
      );
      assert.strictEqual(limited.body.error.code, 'RATE_LIMITED');
      assert.match(limited.headers['ratelimit-limit'] || '', /\d/, 'missing RateLimit headers');
      assert.ok(limited.headers['retry-after'], 'missing Retry-After header');
    });
  }
);
