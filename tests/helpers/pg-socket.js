'use strict';

/**
 * Serve an in-process PostgreSQL (PGlite) over TCP so the REAL `pg` driver and
 * our production pool wrapper (src/db/pool.js) can be tested end to end.
 */

const net = require('node:net');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { createPgDb } = require('../../src/db/pool');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** @returns {Promise<{db: object, url: string, stop: () => Promise<void>}>} */
async function startPgOverSocket() {
  const pglite = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  const db = createPgDb(url, { max: 4 });
  return {
    db,
    url,
    async stop() {
      await db.close();
      await server.stop();
      await pglite.close();
    },
  };
}

module.exports = { startPgOverSocket };
