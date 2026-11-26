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

const os = require('node:os');
const { loadEnv } = require('../src/config/env');
const { createLogger } = require('../src/config/logger');
const { createServer } = require('../src/server');
const { createPgliteDb } = require('./pglite-db');
const { createGameRegistry } = require('../src/platform/game-registry');
const setGame = require('../src/games/set');
const rummyGame = require('../src/games/rummy');

/** A winning SET hand: a LIFE (7777) and three sets. */
const WINNING_SET_HAND = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C';

/**
 * Local testing only (production never runs this file):
 *  - DEV_ELIMINATION_THRESHOLD=20 makes games end after a few rounds, so the
 *    elimination and winner screens can be seen quickly.
 *  - DEV_WINNING_HAND=1 deals the room's host a winning hand in round 1 of a
 *    SET game, with the first turn: press Sort, then Declare, to see what the
 *    other players get after a valid declaration (arrange + Submit).
 */
function devRegistry() {
  const threshold = Number(process.env.DEV_ELIMINATION_THRESHOLD);
  const winningHand = process.env.DEV_WINNING_HAND === '1';
  if (!threshold && !winningHand) return undefined;
  const game = {
    ...setGame,
    createGame: (args) => {
      const created = setGame.createGame(threshold ? { ...args, config: { ...args.config, eliminationThreshold: threshold } } : args);
      if (winningHand) {
        // eslint-disable-next-line global-require -- test helper, only needed in this mode
        const { rigHands, setOpenJoker } = require('../tests/helpers/cards');
        const host = created.state.seatOrder[0];
        setOpenJoker(created.state, 'A');
        rigHands(created.state, { [host]: WINNING_SET_HAND });
        created.state.round.currentPlayerId = host;
      }
      return created;
    },
  };
  return createGameRegistry([game, rummyGame]);
}

/**
 * Local testing on a phone: the frontend is opened at http://<this computer's
 * Wi-Fi address>:4200, so that address must be allowed too.
 */
function lanOrigins() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:4200`);
}

(async () => {
  const env = loadEnv({
    NODE_ENV: 'development',
    PORT: '3000',
    CLIENT_ORIGIN: ['http://localhost:4200', 'http://127.0.0.1:4200', ...lanOrigins()].join(','),
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
