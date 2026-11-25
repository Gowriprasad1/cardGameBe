'use strict';

/**
 * Integration-test harness: a real HTTP + Socket.IO server backed by an
 * in-process PostgreSQL (PGlite), so the real SQL, constraints and
 * transactions run. Clients are real socket.io-client connections.
 */

const { connectClient, rid } = require('./client');
const { loadEnv } = require('../../src/config/env');
const { createLogger } = require('../../src/config/logger');
const { createServer } = require('../../src/server');

const { createPgliteDb } = require('../../scripts/pglite-db');

/**
 * @param {{db?: object, env?: Record<string,string>}} [opts]
 */
async function startTestServer({ db, env = {} } = {}) {
  const database = db || (await createPgliteDb());
  const config = loadEnv({
    NODE_ENV: 'test',
    CLIENT_ORIGIN: 'http://localhost:4200',
    LOG_LEVEL: 'silent',
    TURN_TIMER_SECONDS: '0',
    ROUND_BREAK_SECONDS: '600',
    RATE_LIMIT_API: '100000',
    RATE_LIMIT_STRICT: '100000',
    ...env,
  });
  const server = await createServer({ env: config, db: database, logger: createLogger({ level: 'silent' }) });
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const clients = [];
  const api = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, headers: res.headers, json };
  };

  /** Create a guest and open a live socket for them. */
  const player = async (nickname) => {
    const created = await api('POST', '/api/guests', { body: { nickname } });
    const { userId, token } = created.json.data;
    const client = connectClient(base, token);
    await client.ready;
    clients.push(client);
    return { userId, token, nickname, client, reconnect: async () => {
      const again = connectClient(base, token);
      await again.ready;
      clients.push(again);
      return again;
    } };
  };

  /** Open a new socket for an existing token (e.g. after a restart). */
  const connect = async (token) => {
    const client = connectClient(base, token);
    await client.ready;
    clients.push(client);
    return client;
  };

  return {
    ...server,
    db: database,
    base,
    port,
    api,
    player,
    connect,
    async stop({ keepDb = false } = {}) {
      for (const c of clients) c.socket.close();
      await server.close();
      if (!keepDb) await database.close();
    },
  };
}

module.exports = { createPgliteDb, startTestServer, connectClient, rid };
