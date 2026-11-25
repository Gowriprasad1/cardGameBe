'use strict';

const http = require('node:http');
const { loadEnv } = require('./config/env');
const { createLogger } = require('./config/logger');
const { createPgDb } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { createContainer } = require('./platform/container');
const { createApp } = require('./app');
const { attachSocket } = require('./socket');

/**
 * Build a runnable server. `db` is injectable so tests can use an in-process
 * Postgres; production passes nothing and gets a pg pool (Neon).
 */
async function createServer({ env = loadEnv(), db, logger = createLogger({ level: env.logLevel }), registry } = {}) {
  const database = db || (() => {
    if (!env.databaseUrl) throw new Error('DATABASE_URL is required');
    return createPgDb(env.databaseUrl);
  })();

  if (env.autoMigrate) await migrate(database, { log: (m) => logger.info(m) });

  const container = createContainer({ env, db: database, logger, ...(registry ? { registry } : {}) });
  const app = createApp(container);
  const httpServer = http.createServer(app);
  const io = attachSocket(httpServer, container);
  await container.start();

  return {
    container,
    app,
    httpServer,
    io,
    listen: (port = env.port) => new Promise((resolve) => {
      httpServer.listen(port, () => resolve(httpServer.address().port));
    }),
    async close() {
      await container.stop();
      await new Promise((resolve) => io.close(resolve));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
      if (!db && database.close) await database.close();
    },
  };
}

if (require.main === module) {
  (async () => {
    const env = loadEnv();
    const logger = createLogger({ level: env.logLevel });
    const server = await createServer({ env, logger });
    const port = await server.listen();
    logger.info('server listening', { port, nodeEnv: env.nodeEnv });

    let closing = false;
    const shutdown = async (signal) => {
      if (closing) return;
      closing = true;
      logger.info('shutting down', { signal });
      await server.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
    // A truly unexpected exception leaves the process in an unknown state: log it and let the
    // platform restart us. Games are saved after every move, so players reconnect to where they were.
    process.on('uncaughtException', (err) => {
      logger.error('uncaught exception, exiting', { err });
      process.exit(1);
    });
  })().catch((err) => {
    process.stderr.write(`Failed to start: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { createServer };
