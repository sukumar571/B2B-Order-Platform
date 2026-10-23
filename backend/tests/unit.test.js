'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const logger = require('../src/utils/logger');
const { ApiError } = require('../src/utils/errors');

describe('logger.redact (FR-AUD-05 / NFR-01 secret hygiene)', () => {
  test('redacts secret-looking keys at any depth', () => {
    const input = {
      user: 'alice',
      password: 'hunter2',
      nested: { jwt_token: 'abc.def.ghi', Authorization: 'Bearer xyz' },
      list: [{ secret: 's3cr3t', safe: 'ok' }],
    };
    const out = logger.redact(input);
    assert.strictEqual(out.user, 'alice');
    assert.strictEqual(out.password, '[REDACTED]');
    assert.strictEqual(out.nested.jwt_token, '[REDACTED]');
    assert.strictEqual(out.nested.Authorization, '[REDACTED]');
    assert.strictEqual(out.list[0].secret, '[REDACTED]');
    assert.strictEqual(out.list[0].safe, 'ok');
  });

  test('passes through primitives safely', () => {
    assert.strictEqual(logger.redact('plain'), 'plain');
    assert.strictEqual(logger.redact(42), 42);
    assert.strictEqual(logger.redact(null), null);
  });
});

describe('ApiError', () => {
  test('factories produce stable codes and statuses', () => {
    assert.strictEqual(ApiError.notFound().status, 404);
    assert.strictEqual(ApiError.notFound().code, 'NOT_FOUND');
    assert.strictEqual(ApiError.badRequest('x', { a: 1 }).status, 400);
    assert.strictEqual(ApiError.internal().code, 'INTERNAL_ERROR');
  });
});
