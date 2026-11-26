'use strict';

/**
 * Environment configuration. Secrets (DATABASE_URL) come only from the
 * environment, never from code or the repo.
 */

function toInt(source, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Environment variable ${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function toBool(source, key, fallback) {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes'].includes(String(raw).toLowerCase());
}

/** @param {NodeJS.ProcessEnv} [source] */
function loadEnv(source = process.env) {
  const nodeEnv = source.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    // Fail fast on a misconfigured deployment instead of silently allowing the wrong origin.
    if (!source.CLIENT_ORIGIN) throw new Error('CLIENT_ORIGIN must be set in production (your frontend URL)');
    if (!source.DATABASE_URL) throw new Error('DATABASE_URL must be set in production');
  }
  const clientOrigins = (source.CLIENT_ORIGIN || 'http://localhost:4200')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  for (const origin of clientOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error(`CLIENT_ORIGIN has an invalid entry: "${origin}" (use https://host, no path)`);
  }
  return Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: toInt(source, 'PORT', 3000, { min: 0, max: 65535 }),
    /** network address to listen on; unset = every address (the normal case) */
    host: source.HOST || undefined,
    databaseUrl: source.DATABASE_URL || null,
    clientOrigins,
    logLevel: source.LOG_LEVEL || 'info',
    autoMigrate: toBool(source, 'AUTO_MIGRATE', false),
    /** pause between the round result screen and the next deal */
    roundBreakSeconds: toInt(source, 'ROUND_BREAK_SECONDS', 10, { max: 600 }),
    /** 0 turns the turn timer off */
    turnTimerSeconds: toInt(source, 'TURN_TIMER_SECONDS', 60, { max: 600 }),
    /** speed of the computer player's "thinking" pauses: 1 = like a person, 0 = instant (tests) */
    botDelayScale: Number(source.BOT_DELAY_SCALE ?? 1) >= 0 ? Number(source.BOT_DELAY_SCALE ?? 1) : 1,
    /** after a valid declaration, how long the other players get to arrange their cards and submit (0 = score at once) */
    showWindowSeconds: toInt(source, 'SHOW_WINDOW_SECONDS', 30, { max: 300 }),
    /** with the turn timer off, how long a disconnected player's turn waits before it is auto-played */
    reconnectGraceSeconds: toInt(source, 'RECONNECT_GRACE_SECONDS', 90, { min: 1, max: 3600 }),
    /** a room with nobody connected for this long is abandoned */
    roomIdleMinutes: toInt(source, 'ROOM_IDLE_MINUTES', 30, { min: 1 }),
    /** Keep every card, action and snapshot of finished games (debugging). Default: keep only the final result. */
    keepFullGameData: toBool(source, 'KEEP_FULL_GAME_DATA', false),
    /** Finished or abandoned rooms older than this many days are deleted completely. 0 keeps them forever. */
    dataRetentionDays: toInt(source, 'DATA_RETENTION_DAYS', 30, { min: 0 }),
    /** Socket events: burst size and sustained events per second, per connection */
    socketBurst: toInt(source, 'SOCKET_BURST', 20, { min: 1 }),
    socketRatePerSecond: toInt(source, 'SOCKET_RATE_PER_SECOND', 8, { min: 1 }),
    /** per client address, per minute */
    rateLimitApi: toInt(source, 'RATE_LIMIT_API', 120, { min: 1 }),
    rateLimitStrict: toInt(source, 'RATE_LIMIT_STRICT', 20, { min: 1 }),
  });
}

module.exports = { loadEnv };
