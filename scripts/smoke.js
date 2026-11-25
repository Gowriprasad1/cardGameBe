'use strict';

/**
 * End-to-end smoke test: bots play a whole game over real sockets and the
 * result is verified. Two modes:
 *
 *  1. Against YOUR DATABASE (for example Neon). The backend runs inside this
 *     script and talks to the database in DATABASE_URL. Migrations are applied,
 *     a 2-player game is played to the end, the saved rows are checked, and the
 *     test data is deleted again.
 *
 *       DATABASE_URL='postgres://...' npm run smoke
 *
 *  2. Against a DEPLOYED backend (for example on Render). Nothing runs locally
 *     except the bots. Set SMOKE_ORIGIN to your frontend's URL to also check CORS.
 *     Test users and rooms stay in that database (they are tiny and harmless).
 *
 *       SMOKE_URL='https://your-service.onrender.com' SMOKE_ORIGIN='https://your-app.vercel.app' npm run smoke
 */

process.env.EMIT_TIMEOUT_MS = process.env.EMIT_TIMEOUT_MS || '60000'; // remote databases can be slow

const { loadEnv } = require('../src/config/env');
const { createLogger } = require('../src/config/logger');
const { createPgDb } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');
const { createServer } = require('../src/server');
const { createGameRegistry } = require('../src/platform/game-registry');
const setGame = require('../src/games/set');
const { connectClient } = require('../tests/helpers/client');
const { attachBot } = require('../tests/helpers/socket-bot');

/** Everything this run created, so it can be removed even if the run fails. */
const created = { userIds: [], roomCodes: [] };

const ok = (msg) => process.stdout.write(`  ok  ${msg}\n`);
const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => { if (!cond) fail(msg); ok(msg); };

async function http(base, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

async function playGame(base, label) {
  const bots = [];
  for (let i = 0; i < 2; i += 1) {
    const guest = (await http(base, '/api/guests', { method: 'POST', body: { nickname: `${label}${i}` } })).json.data;
    const client = connectClient(base, guest.token);
    await client.ready;
    bots.push({ ...guest, client });
    created.userIds.push(guest.userId);
  }
  try {
    const { roomCode } = (await bots[0].client.emit('create-room', {})).data;
    created.roomCodes.push(roomCode);
    const joined = await bots[1].client.emit('join-room', { roomCode });
    check(joined.ok, `room ${roomCode} created and joined`);
    bots.forEach((b, i) => attachBot(b.client, { maxTurns: 6, quitsFirst: i === 0 }));
    const start = await bots[0].client.emit('start-game', {});
    check(start.ok, 'game started (dealt and saved)');
    const done = await Promise.all(bots.map((b) => b.client.waitFor('game-completed', { timeout: 240000 })));
    for (const b of bots) if (b.client.botError) fail(`bot error: ${b.client.botError.message}`);
    const final = done[0].payload;
    check(final.totalRounds >= 1 && final.winnerId, `game finished after ${final.totalRounds} rounds, winner ${final.winnerNickname}`);
    const sessionId = (await bots[0].client.emit('resume', {})).data.room.sessionId;
    const history = await http(base, `/api/sessions/${sessionId}/history`, { headers: { Authorization: `Bearer ${bots[0].token}` } });
    check(history.status === 200 && history.json.data.rounds.length === final.totalRounds, 'round history readable over REST');
    return { bots, roomCode, sessionId, final };
  } finally {
    for (const b of bots) b.client.socket.close();
  }
}

async function runLocalServerOnDatabase(databaseUrl) {
  const db = createPgDb(databaseUrl, { max: 4 });
  let server;
  let result;
  try {
    const started = Date.now();
    await db.query('SELECT 1');
    ok(`connected to the database (${Date.now() - started} ms)`);
    const applied = await migrate(db);
    ok(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations already up to date');

    const env = loadEnv({
      DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'warn', TURN_TIMER_SECONDS: '0', ROUND_BREAK_SECONDS: '600',
      SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000', RATE_LIMIT_STRICT: '1000',
    });
    // Same rules, but the game ends at 41 points instead of 201 so it finishes in a few rounds
    // even when the database is far away. Set SMOKE_FULL=1 to play to 201.
    const short = process.env.SMOKE_FULL ? undefined : createGameRegistry([{
      ...setGame,
      createGame: (args) => setGame.createGame({ ...args, config: { ...args.config, eliminationThreshold: 41 } }),
    }]);
    if (short) ok('short game: eliminated at 41 points (SMOKE_FULL=1 plays to 201)');
    server = await createServer({ env, db, logger: createLogger({ level: 'warn' }), registry: short });
    const port = await server.listen(0);
    const base = `http://127.0.0.1:${port}`;
    check((await http(base, '/api/health')).status === 200, 'health check reaches the database');

    const t0 = Date.now();
    result = await playGame(base, 'Smoke');
    ok(`whole game took ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    const q = async (sql, params) => (await db.query(sql, params)).rows;
    const [h] = await q('SELECT total_rounds, winner_user_id FROM game_history WHERE session_id = $1', [result.sessionId]);
    check(h && h.total_rounds === result.final.totalRounds, 'game_history saved');
    const [dup] = await q(
      'SELECT count(*)::int AS n FROM (SELECT round_id, room_player_id FROM player_scores WHERE session_id = $1 GROUP BY 1,2 HAVING count(*) > 1) d',
      [result.sessionId]);
    check(dup.n === 0, 'no score was saved twice');
    const [cards] = await q(
      `SELECT count(*)::int AS n FROM card_decks cd JOIN game_rounds gr ON gr.id = cd.round_id WHERE gr.session_id = $1`, [result.sessionId]);
    check(cards.n === 54 * result.final.totalRounds, 'every round has all 54 cards stored once');
  } finally {
    if (server) await server.close();
    // remove everything this run created, also after a failure
    if (created.roomCodes.length || created.userIds.length) {
      await db.query('DELETE FROM game_sessions WHERE room_id IN (SELECT id FROM game_rooms WHERE room_code = ANY($1::text[]))', [created.roomCodes]);
      await db.query('DELETE FROM game_rooms WHERE room_code = ANY($1::text[])', [created.roomCodes]);
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [created.userIds]);
      ok('test data deleted');
    }
    await db.close();
  }
}

async function runAgainstDeployed(base, origin) {
  const health = await http(base, '/api/health');
  check(health.status === 200, `GET ${base}/api/health is up`);
  if (origin) {
    const pre = await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    check(pre.headers.get('access-control-allow-origin') === origin, `CORS allows ${origin}`);
    const bad = await fetch(`${base}/api/health`, { headers: { Origin: 'https://not-allowed.example' } });
    check(bad.headers.get('access-control-allow-origin') === null, 'CORS refuses other origins');
  }
  const t0 = Date.now();
  await playGame(base, 'Smoke');
  ok(`whole game took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

(async () => {
  const remote = process.env.SMOKE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!remote && !databaseUrl) {
    process.stderr.write('Set DATABASE_URL (test your database) or SMOKE_URL (test a deployed backend).\n');
    process.exit(2);
  }
  process.stdout.write(remote ? `Smoke test against ${remote}\n` : 'Smoke test against DATABASE_URL\n');
  if (remote) await runAgainstDeployed(remote.replace(/\/$/, ''), process.env.SMOKE_ORIGIN);
  else await runLocalServerOnDatabase(databaseUrl);
  process.stdout.write('PASSED\n');
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`FAILED: ${err.message}\n`);
  process.exit(1);
});
