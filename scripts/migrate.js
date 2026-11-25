'use strict';

/* Usage: DATABASE_URL=postgres://... npm run migrate */

const { loadEnv } = require('../src/config/env');
const { createPgDb } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');

(async () => {
  const env = loadEnv();
  if (!env.databaseUrl) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }
  const db = createPgDb(env.databaseUrl, { max: 2 });
  try {
    const applied = await migrate(db, { log: (m) => process.stdout.write(`${m}\n`) });
    process.stdout.write(applied.length ? `Done. Applied: ${applied.join(', ')}\n` : 'Database is up to date.\n');
  } finally {
    await db.close();
  }
})().catch((err) => {
  process.stderr.write(`Migration failed: ${err.message}\n`);
  process.exit(1);
});
