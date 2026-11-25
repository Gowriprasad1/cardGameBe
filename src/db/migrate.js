'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

/**
 * Apply every migration file that has not run yet, in filename order.
 * Safe to run on every deploy.
 * @param {{query: Function, withTransaction: Function}} db
 * @returns {Promise<string[]>} versions applied now
 */
async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.withTransaction((tx) => tx.query(sql));
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
    applied.push(version);
    log(`applied migration ${version}`);
  }
  return applied;
}

module.exports = { migrate };
