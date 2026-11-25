'use strict';

/**
 * An in-process PostgreSQL (PGlite) behind the same `db` interface as the real
 * pg pool. Used by the tests and by `npm run dev:local`. It is a development
 * tool: production always uses Neon through DATABASE_URL.
 */

const { migrate } = require('../src/db/migrate');

/** @param {string} [dataDir] folder to keep data between runs; omit for memory only */
async function createPgliteDb(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const run = async (target, text, params) => {
    if (params === undefined) {
      const results = await target.exec(text);
      const last = results[results.length - 1];
      return { rows: last ? last.rows : [], rowCount: last ? (last.affectedRows ?? last.rows.length) : 0 };
    }
    const r = await target.query(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const db = {
    pg,
    query: (text, params) => run(pg, text, params),
    withTransaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => run(tx, text, params) })),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

module.exports = { createPgliteDb };
