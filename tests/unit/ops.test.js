'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEnv } = require('../../src/config/env');
const { explicitSsl } = require('../../src/db/pool');
const { createLogger, redact } = require('../../src/config/logger');

test('production refuses to start without CLIENT_ORIGIN or DATABASE_URL', () => {
  assert.throws(() => loadEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' }), /CLIENT_ORIGIN/);
  assert.throws(() => loadEnv({ NODE_ENV: 'production', CLIENT_ORIGIN: 'https://a.app' }), /DATABASE_URL/);
  const env = loadEnv({ NODE_ENV: 'production', CLIENT_ORIGIN: 'https://a.app/, https://b.app', DATABASE_URL: 'postgres://x' });
  assert.deepEqual(env.clientOrigins, ['https://a.app', 'https://b.app']);
  assert.equal(env.isProduction, true);
});

test('CLIENT_ORIGIN entries must be plain origins', () => {
  for (const bad of ['a.app', 'https://a.app/path', 'ftp://a.app', '*']) {
    assert.throws(() => loadEnv({ CLIENT_ORIGIN: bad }), /CLIENT_ORIGIN/, bad);
  }
  assert.deepEqual(loadEnv({}).clientOrigins, ['http://localhost:4200']);
});

test('sslmode=require is made explicit (verify-full) without touching other parts of the URL', () => {
  const out = explicitSsl('postgresql://u:p%40ss@ep-x-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require');
  assert.match(out, /sslmode=verify-full/);
  assert.match(out, /channel_binding=require/);
  assert.match(out, /u:p%40ss@/);
  assert.equal(explicitSsl('postgres://h/db?sslmode=disable'), 'postgres://h/db?sslmode=disable');
  assert.equal(explicitSsl('not a url'), 'not a url');
});

test('logs never contain tokens, cards or connection strings', () => {
  const lines = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
  log.info('x', { token: 'secret-token', hand: ['D1-H-7'], databaseUrl: 'postgres://u:pw@h/db', nested: { authorization: 'Bearer abc', groups: [['a']] }, ok: 1 });
  const text = lines.join('\n');
  for (const secret of ['secret-token', 'D1-H-7', 'pw@h', 'Bearer abc']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('"ok":1'));
  assert.deepEqual(redact({ state: { a: 1 } }), { state: '[redacted]' });
});
