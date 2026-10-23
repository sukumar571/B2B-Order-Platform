'use strict';

process.env.NODE_ENV = 'test';
// Force "no database configured" so HTTP-layer tests stay deterministic and
// never touch a real database, even when backend/.env defines these vars.
process.env.DATABASE_URL = '';
process.env.DATABASE_URL_TEST = '';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { createApp } = require('../src/app');

const app = createApp();

describe('GET /api/health', () => {
  test('returns 200 with status ok JSON body', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.db.state, 'not_configured');
    assert.strictEqual(typeof res.body.uptimeSeconds, 'number');
    assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)), 'timestamp is ISO-8601');
  });

  test('sends security headers from helmet', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.strictEqual(res.headers['x-powered-by'], undefined);
  });

  test('rejects non-GET methods with a consistent 404 JSON error', async () => {
    const res = await request(app).post('/api/health');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.code, 'NOT_FOUND');
  });
});

describe('Unknown routes', () => {
  test('returns consistent JSON 404 envelope with error code', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    assert.strictEqual(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.strictEqual(res.body.error.code, 'NOT_FOUND');
    assert.strictEqual(typeof res.body.error.message, 'string');
  });

  test('does not leak stack traces or internals in the 404 body', async () => {
    const res = await request(app).get('/nope');
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes('at '), 'no stack frames in response');
    assert.ok(!raw.includes('node_modules'), 'no file paths in response');
  });
});

describe('Request parsing and error handling', () => {
  test('malformed JSON body yields 400 INVALID_JSON, not a crash', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'INVALID_JSON');
  });

  test('oversized JSON body is rejected with 413 (limit from config)', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(102 * 1024) }));
    assert.strictEqual(res.status, 413);
    assert.strictEqual(res.body.error.code, 'PAYLOAD_TOO_LARGE');
  });
});
