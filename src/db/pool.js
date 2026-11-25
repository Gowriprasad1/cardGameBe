'use strict';

/**
 * Database access. Everything in the app talks to a small `db` object:
 *
 *   db.query(text, params)            -> { rows, rowCount }
 *   db.withTransaction(async (tx) => ...)   tx has the same query() method
 *
 * Production wraps a `pg` Pool (Neon). Tests wrap an in-process Postgres
 * (PGlite) behind the same interface, so the real SQL and constraints run.
 */

/**
 * `sslmode=require` is what Neon shows. The pg driver already treats it as full
 * certificate verification and warns that this will change; naming the mode
 * explicitly keeps today's (secure) behaviour and silences the warning.
 */
function explicitSsl(connectionString) {
  try {
    const url = new URL(connectionString);
    if (['require', 'prefer', 'verify-ca'].includes(url.searchParams.get('sslmode')) && !url.searchParams.has('uselibpqcompat')) {
      url.searchParams.set('sslmode', 'verify-full');
      return url.toString();
    }
  } catch { /* not a URL: leave it to pg to complain */ }
  return connectionString;
}

function createPgDb(rawConnectionString, { max = 10 } = {}) {
  const { Pool } = require('pg');
  const connectionString = explicitSsl(rawConnectionString);
  const pool = new Pool({ connectionString, max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {
    // idle client errors must not crash the process; the next query reconnects
  });
  return {
    query: (text, params) => pool.query(text, params),
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Postgres unique violation. */
const isUniqueViolation = (err) => Boolean(err) && err.code === '23505';

/**
 * Build `($1,$2),($3,$4)` placeholders for a multi-row insert.
 * @param {any[][]} rows
 * @returns {{sql: string, params: any[]}}
 */
function valuesClause(rows, casts = []) {
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value, i) => {
      params.push(value);
      return `$${params.length}${casts[i] ? `::${casts[i]}` : ''}`;
    });
    return `(${placeholders.join(',')})`;
  });
  return { sql: tuples.join(','), params };
}

module.exports = { createPgDb, explicitSsl, isUniqueViolation, valuesClause };
