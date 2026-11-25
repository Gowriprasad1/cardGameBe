'use strict';

/**
 * Run the whole backend locally WITHOUT a Neon database, using an in-process
 * PostgreSQL. Handy for working on the frontend:
 *
 *   npm run dev:local              data is kept in memory (lost on exit)
 *   PGLITE_DIR=.dev-data npm run dev:local   data is kept in that folder
 *
 * Never use this in production.
 */

const { loadEnv } = require('../src/config/env');
const { createLogger } = require('../src/config/logger');
const { createServer } = require('../src/server');
const { createPgliteDb } = require('./pglite-db');
const { createGameRegistry } = require('../src/platform/game-registry');
const setGame = require('../src/games/set');

/**
 * Local testing only: DEV_ELIMINATION_THRESHOLD=20 makes games end after a few
 * rounds, so the elimination and winner screens can be seen quickly.
 */
function devRegistry() {
  const threshold = Number(process.env.DEV_ELIMINATION_THRESHOLD);
  if (!threshold) return undefined;
  const game = { ...setGame, createGame: (args) => setGame.createGame({ ...args, config: { ...args.config, eliminationThreshold: threshold } }) };
  return createGameRegistry([game]);
}

(async () => {
  const env = loadEnv({
    NODE_ENV: 'development',
    PORT: '3000',
    CLIENT_ORIGIN: 'http://localhost:4200,http://127.0.0.1:4200',
    LOG_LEVEL: 'info',
    ...process.env,
  });
  const logger = createLogger({ level: env.logLevel });
  const db = await createPgliteDb(process.env.PGLITE_DIR);
  const server = await createServer({ env, db, logger, registry: devRegistry() });
  const port = await server.listen();
  logger.info('local dev backend ready (embedded PostgreSQL)', { port, persistent: Boolean(process.env.PGLITE_DIR) });
  const stop = async () => { await server.close(); await db.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => {
  process.stderr.write(`dev server failed: ${err.stack}\n`);
  process.exit(1);
});
