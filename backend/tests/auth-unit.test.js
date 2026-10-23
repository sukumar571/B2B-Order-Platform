'use strict';

process.env.NODE_ENV = 'test';
// No database and no operator-provided secrets needed for pure logic tests —
// config falls back to deterministic dev secrets (never used in production).
process.env.DATABASE_URL = '';
process.env.DATABASE_URL_TEST = '';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../src/config/env');
const { validateInput, registerSchema, loginSchema } = require('../src/utils/validators');
const { ApiError } = require('../src/utils/errors');
const tokenService = require('../src/services/token.service');
const authService = require('../src/services/auth.service');
const { authorize, requireOwnership, requireSelf } = require('../src/middleware/authorize');

const GOOD = { email: 'Alice@Example.COM', password: 'Str0ngPassw0rd', name: 'Alice Trade' };

describe('auth validators (Zod)', () => {
  test('accepts a valid registration and normalizes the email to lowercase', () => {
    const out = validateInput(registerSchema, GOOD);
    assert.strictEqual(out.email, 'alice@example.com');
    assert.strictEqual(out.name, 'Alice Trade');
  });

  test('rejects malformed emails, short and complex-less passwords, blank names', () => {
    for (const bad of [
      { ...GOOD, email: 'not-an-email' },
      { ...GOOD, password: 'Sh0rt!' }, // < 10 chars
      { ...GOOD, password: 'alllettersandmore' }, // no digit
      { ...GOOD, password: '12345678901234' }, // no letter
      { ...GOOD, name: '   ' },
    ]) {
      assert.throws(
        () => validateInput(registerSchema, bad),
        (err) => err instanceof ApiError && err.code === 'VALIDATION_ERROR',
        `should have rejected: ${JSON.stringify(bad)}`
      );
    }
  });

  test('validation details never echo the submitted password', () => {
    try {
      validateInput(registerSchema, { ...GOOD, password: 'sh0rt' });
      assert.fail('expected throw');
    } catch (err) {
      assert.strictEqual(err.status, 400);
      assert.ok(!JSON.stringify(err.details || {}).includes('sh0rt'), 'details leak password');
    }
  });

  test('strict schemas reject unexpected fields — role injection attempts fail', () => {
    assert.throws(
      () => validateInput(registerSchema, { ...GOOD, role: 'ADMIN' }),
      (err) => err instanceof ApiError && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => validateInput(loginSchema, { email: GOOD.email, password: GOOD.password, is_admin: 1 }),
      (err) => err instanceof ApiError && err.code === 'VALIDATION_ERROR'
    );
  });
});

describe('token service (JWT)', () => {
  test('access token round-trips and pins HS256 + iss + aud + typ claims', () => {
    const token = tokenService.signAccessToken({ userId: 42, role: 'customer' });
    const decoded = jwt.decode(token, { complete: true });
    assert.strictEqual(decoded.header.alg, 'HS256');
    assert.strictEqual(decoded.payload.iss, config.jwtIssuer);
    assert.strictEqual(decoded.payload.aud, config.jwtAudience);
    assert.strictEqual(decoded.payload.typ, 'access');
    const payload = tokenService.verifyAccessToken(token);
    assert.strictEqual(payload.sub, '42');
  });

  test('malformed tokens are rejected without throwing', () => {
    for (const junk of ['garbage', 'a.b.c', '', 'Bearer x'.slice(7)]) {
      assert.strictEqual(tokenService.verifyAccessToken(junk), null, `accepted "${junk}"`);
    }
  });

  test('expired tokens are rejected', () => {
    const expired = jwt.sign(
      { sub: '1', role: 'customer', typ: 'access' },
      config.jwtAccessSecret,
      {
        algorithm: 'HS256',
        expiresIn: '-30s',
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      }
    );
    assert.strictEqual(tokenService.verifyAccessToken(expired), null);
  });

  test('wrong-signature tokens are rejected', () => {
    const forged = jwt.sign({ sub: '1', typ: 'access' }, 'someone-elses-secret-0123456789abcdef', {
      algorithm: 'HS256',
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    assert.strictEqual(tokenService.verifyAccessToken(forged), null);
  });

  test('wrong issuer / audience are rejected', () => {
    for (const opts of [{ iss: 'evil-issuer' }, { aud: 'evil-audience' }]) {
      const bad = jwt.sign({ sub: '1', typ: 'access', ...opts }, config.jwtAccessSecret, {
        algorithm: 'HS256',
        expiresIn: '5m',
      });
      assert.strictEqual(
        tokenService.verifyAccessToken(bad),
        null,
        `accepted ${JSON.stringify(opts)}`
      );
    }
  });

  test('alg:none tokens are rejected', () => {
    const none = jwt.sign({ sub: '1', typ: 'access' }, '', { algorithm: 'none' });
    assert.strictEqual(tokenService.verifyAccessToken(none), null);
  });

  test('a refresh token envelope can NEVER act as a bearer access token', () => {
    const { envelope } = tokenService.signRefreshToken({ userId: 7, familyId: 'f' });
    assert.strictEqual(tokenService.verifyAccessToken(envelope), null, 'wrong secret must fail');
    const asRefresh = tokenService.verifyRefreshEnvelope(envelope);
    assert.ok(asRefresh && tokenService.isAccessPayload(asRefresh) === false);
  });

  test('refresh raw secrets are only ever exposed as SHA-256 hashes', () => {
    const { raw, hash, envelope } = tokenService.signRefreshToken({ userId: 1, familyId: 'f' });
    assert.strictEqual(hash, tokenService.sha256Hex(raw));
    assert.ok(!envelope.includes(raw), 'envelope must not embed the raw secret');
    assert.strictEqual(jwt.decode(envelope).jti, hash, 'envelope carries the hash as jti');
  });

  test('extractBearer parses the Authorization header strictly', () => {
    const pick = (headers) => tokenService.extractBearer({ headers });
    assert.strictEqual(pick({ authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
    assert.strictEqual(pick({ authorization: 'bearer abc.def.ghi' }), 'abc.def.ghi');
    assert.strictEqual(pick({ authorization: 'Token abc' }), null);
    assert.strictEqual(pick({}), null);
  });
});

describe('auth service pure helpers', () => {
  test('toPublicUser strips password material entirely', () => {
    const pub = authService.toPublicUser({
      id: '5',
      email: 'a@b.test',
      password_hash: '$2b$12$leakme',
      name: 'A',
      role: 'customer',
      is_active: true,
      created_at: 'when',
    });
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('leakme'), 'hash leaked into public user');
    assert.ok(!('password_hash' in pub) && !('passwordHash' in pub));
    assert.strictEqual(pub.id, '5');
  });

  test('ttlMs parses jsonwebtoken-style durations', () => {
    assert.strictEqual(authService.ttlMs('15m'), 15 * 60 * 1000);
    assert.strictEqual(authService.ttlMs('7d'), 7 * 86400000);
    assert.strictEqual(authService.ttlMs('900s'), 900000);
    assert.strictEqual(authService.ttlMs('120'), 120000);
    assert.throws(() => authService.ttlMs('soon'));
  });
});

describe('authorize / ownership middleware', () => {
  const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err || 'pass')));

  test('authorize() allows any of the listed roles and 403s the rest', async () => {
    const adminOnly = authorize('ADMIN');
    assert.strictEqual(await run(adminOnly, { user: { role: 'admin' } }), 'pass');
    const err = await run(adminOnly, { user: { role: 'customer' } });
    assert.ok(err instanceof ApiError && err.status === 403 && err.code === 'FORBIDDEN');
    // staff set: ORDER_MANAGER (DB value "agent") and ADMIN both pass
    const staff = authorize('ADMIN', 'ORDER_MANAGER');
    assert.strictEqual(await run(staff, { user: { role: 'agent' } }), 'pass');
    assert.strictEqual(await run(staff, { user: { role: 'admin' } }), 'pass');
    assert.strictEqual(await run(staff, { user: { role: 'customer' } }).then((r) => r.status), 403);
  });

  test('authorize() 401s unauthenticated requests and validates its role list', async () => {
    const err = await run(authorize('ADMIN'), {});
    assert.ok(err instanceof ApiError && err.status === 401 && err.code === 'UNAUTHENTICATED');
    assert.throws(() => authorize('WIZARD'), /no valid roles/);
  });

  test('requireSelf demands an authenticated identity', async () => {
    assert.strictEqual(await run(requireSelf, { user: { id: '1' } }), 'pass');
    const err = await run(requireSelf, {});
    assert.ok(err instanceof ApiError && err.status === 401);
  });

  test('requireOwnership blocks cross-user access (IDOR) and hides existence', async () => {
    const mw = requireOwnership((req) => req.resourceOwnerId);
    assert.strictEqual(await run(mw, { user: { id: '7' }, resourceOwnerId: '7' }), 'pass');
    const err = await run(mw, { user: { id: '7' }, resourceOwnerId: '8' });
    assert.ok(err instanceof ApiError && err.status === 403 && err.code === 'FORBIDDEN');
    const missing = await run(mw, { user: { id: '7' }, resourceOwnerId: null });
    assert.ok(
      missing instanceof ApiError && missing.status === 404,
      'must 404, not leak existence'
    );
    // admin bypass is opt-in only
    const strict = requireOwnership((req) => req.resourceOwnerId);
    const stillBlocked = await run(strict, {
      user: { id: '1', role: 'admin' },
      resourceOwnerId: '8',
    });
    assert.ok(stillBlocked.status === 403);
    const lenient = requireOwnership((req) => req.resourceOwnerId, { allowAdmin: true });
    assert.strictEqual(
      await run(lenient, { user: { id: '1', role: 'admin' }, resourceOwnerId: '8' }),
      'pass'
    );
  });
});
