'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Keys whose values must never reach the logs (secrets and private cards). */
const REDACT = new Set([
  'token', 'authorization', 'tokenHash', 'token_hash', 'databaseUrl', 'password',
  'cards', 'hand', 'hands', 'groups', 'drawPile', 'discardPile', 'state', 'snapshot',
]);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) out[key] = REDACT.has(key) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

/**
 * Minimal structured (JSON lines) logger.
 * @param {{level?: string, write?: (line: string) => void, base?: object}} [opts]
 */
function createLogger({ level = 'info', write = (line) => process.stdout.write(`${line}\n`), base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, ctx) => (msg, extra = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...ctx, ...redact(extra) };
    if (extra instanceof Error) {
      entry.error = { name: extra.name, message: extra.message, code: extra.code };
    } else if (extra && extra.err instanceof Error) {
      entry.err = { name: extra.err.name, message: extra.err.message, code: extra.err.code, stack: extra.err.stack };
    }
    write(JSON.stringify(entry));
  };
  const make = (ctx) => ({
    debug: log('debug', ctx),
    info: log('info', ctx),
    warn: log('warn', ctx),
    error: log('error', ctx),
    child: (more) => make({ ...ctx, ...more }),
  });
  return make(base);
}

module.exports = { createLogger, redact };
