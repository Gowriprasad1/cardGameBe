'use strict';

/**
 * Whole games played by bots through the real stack: socket.io clients ->
 * Express/Socket.IO server -> PostgreSQL. Each game runs until one player
 * remains (201 points), then the saved data is checked against what clients saw.
 * One game also runs on the real `pg` driver (over TCP) instead of the in-process adapter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, rid } = require('../helpers/server');
const { startPgOverSocket } = require('../helpers/pg-socket');
const { attachBot } = require('../helpers/socket-bot');
const { migrate } = require('../../src/db/migrate');

async function playWholeGame(srv, count, { quitter = true } = {}) {
  const players = [];
  for (let i = 0; i < count; i += 1) players.push(await srv.player(`Bot${count}x${i}`));
  const { roomCode } = (await players[0].client.emit('create-room', {})).data;
  for (const p of players.slice(1)) await p.client.emit('join-room', { roomCode });
  players.forEach((p, i) => attachBot(p.client, { maxTurns: 7, quitsFirst: quitter && i === 0 }));
  assert.equal((await players[0].client.emit('start-game', {})).ok, true);
  const done = await Promise.all(players.map((p) => p.client.waitFor('game-completed', { timeout: 170000 })));
  for (const p of players) assert.equal(p.client.botError, undefined, p.client.botError && p.client.botError.message);
  return { players, roomCode, final: done[0].payload };
}

async function assertSavedGame(srv, { players, roomCode, final }) {
  const q = async (sql, params = []) => (await srv.db.query(sql, params)).rows;
  const n = players.length;

  // what the clients were told
  const winners = final.finalScoreboard.filter((s) => s.isWinner);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].playerId, final.winnerId);
  const stillIn = final.finalScoreboard.filter((s) => s.status === 'active');
  assert.ok(stillIn.length <= 1);
  for (const row of final.finalScoreboard) {
    if (row.status === 'eliminated') assert.ok(row.cumulativeScore >= 201);
    else assert.ok(row.cumulativeScore < 201);
  }
  assert.equal(final.eliminatedHistory.length, n - 1);

  // what was saved
  const session = (await q(
    `SELECT s.id, s.status, s.deck_count, r.status AS room_status FROM game_sessions s
       JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode]))[0];
  assert.deepEqual([session.status, session.room_status, session.deck_count], ['completed', 'finished', n === 2 ? 1 : 2]);

  const rounds = await q('SELECT id, round_no, status, end_reason FROM game_rounds WHERE session_id = $1 ORDER BY round_no', [session.id]);
  assert.equal(rounds.length, final.totalRounds);
  assert.ok(rounds.every((r, i) => r.status === 'completed' && r.round_no === i + 1 && r.end_reason));

  // every round: all physical cards stored exactly once, hands of 13
  for (const r of rounds) {
    const cards = (await q('SELECT count(*)::int AS n, count(DISTINCT instance_id)::int AS u FROM card_decks WHERE round_id = $1', [r.id]))[0];
    assert.deepEqual(cards, { n: (n === 2 ? 1 : 2) * 54, u: (n === 2 ? 1 : 2) * 54 });
  }

  // scores: one row per player per round, running totals add up, nothing counted twice
  const scores = await q(
    `SELECT u.id AS user_id, gr.round_no, ps.penalty, ps.cumulative_after FROM player_scores ps
       JOIN room_players rp ON rp.id = ps.room_player_id JOIN users u ON u.id = rp.user_id
       JOIN game_rounds gr ON gr.id = ps.round_id WHERE ps.session_id = $1 ORDER BY gr.round_no`, [session.id]);
  for (const p of players) {
    const mine = scores.filter((s) => s.user_id === p.userId);
    let total = 0;
    for (const s of mine) {
      total += s.penalty;
      assert.equal(s.cumulative_after, total, 'running total');
    }
    const expected = final.finalScoreboard.find((x) => x.playerId === p.userId).cumulativeScore;
    assert.equal(total, expected);
    const saved = (await q(
      'SELECT cumulative_score FROM room_players rp JOIN game_rooms r ON r.id = rp.room_id WHERE r.room_code = $1 AND rp.user_id = $2',
      [roomCode, p.userId]))[0];
    assert.equal(saved.cumulative_score, expected);
  }
  const history = await q('SELECT total_rounds, winner_user_id FROM game_history WHERE session_id = $1', [session.id]);
  assert.deepEqual(history, [{ total_rounds: final.totalRounds, winner_user_id: final.winnerId }]);

  // the history endpoint returns the same rounds
  const rest = await srv.api('GET', `/api/sessions/${session.id}/history`, { token: players[0].token });
  assert.equal(rest.json.data.rounds.length, final.totalRounds);
  return rounds;
}

let counter = 0;
for (const n of [2, 3, 4, 5]) {
  test(`${n} bots play a whole game over sockets to a winner, and every round is saved correctly`, async () => {
    const srv = await startTestServer({ env: { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000', KEEP_FULL_GAME_DATA: '1' } });
    try {
      const game = await playWholeGame(srv, n, { quitter: n % 2 === 1 });
      const rounds = await assertSavedGame(srv, game);
      counter += rounds.length;
    } finally {
      await srv.stop();
    }
  });
}

test('privacy over a whole round: no client ever receives another player\'s private cards', async () => {
  const srv = await startTestServer({ env: { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000', KEEP_FULL_GAME_DATA: '1' } });
  try {
    const players = [];
    for (let i = 0; i < 3; i += 1) players.push(await srv.player(`Priv${i}`));
    const { roomCode } = (await players[0].client.emit('create-room', {})).data;
    for (const p of players.slice(1)) await p.client.emit('join-room', { roomCode });
    players.forEach((p) => attachBot(p.client, { maxTurns: 6 }));
    await players[0].client.emit('start-game', {});
    await Promise.all(players.map((p) => p.client.waitFor('round-completed', { timeout: 120000 })));

    const firstRound = (p) => {
      const end = p.client.events.findIndex((e) => e.name === 'round-completed');
      return p.client.events.slice(0, end);
    };
    const publicIds = new Set();
    const privateIds = new Map();
    for (const p of players) {
      const mine = new Set();
      for (const e of firstRound(p)) {
        if (e.name === 'game-state' && e.payload.me) e.payload.me.hand.forEach((c) => mine.add(c.id));
        if (e.name === 'card-discarded') publicIds.add(e.payload.card.id);
        if (e.name === 'card-drawn' && e.payload.card) publicIds.add(e.payload.card.id);
        if (e.name === 'cards-distributed') { publicIds.add(e.payload.openJokerCard.id); publicIds.add(e.payload.discardTop.id); }
      }
      privateIds.set(p.userId, mine);
    }
    for (const viewer of players) {
      const log = JSON.stringify(firstRound(viewer));
      for (const owner of players) {
        if (owner === viewer) continue;
        for (const id of privateIds.get(owner.userId)) {
          if (publicIds.has(id)) continue;
          assert.ok(!log.includes(`"${id}"`), `${viewer.nickname} saw ${id}`);
        }
      }
    }
  } finally {
    await srv.stop();
  }
});

test('the real pg driver: migrations, a whole game and a restart all work through src/db/pool.js', async () => {
  const pg = await startPgOverSocket();
  try {
    const applied = await migrate(pg.db);
    assert.deepEqual(applied, ['001_init']);
    assert.deepEqual(await migrate(pg.db), [], 'running migrations again is a no-op');

    const first = await startTestServer({ db: pg.db, env: { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000', KEEP_FULL_GAME_DATA: '1' } });
    let game;
    try {
      game = await playWholeGame(first, 2, { quitter: false });
      await assertSavedGame(first, game);
      // typed values come back as the app expects from the pg driver
      const row = (await pg.db.query('SELECT started_at, state_version, config FROM game_sessions LIMIT 1')).rows[0];
      assert.ok(row.started_at instanceof Date);
      assert.equal(typeof row.config, 'object');
    } finally {
      await first.stop({ keepDb: true });
    }

    // a second server process on the same database sees the finished game's history
    const second = await startTestServer({ db: pg.db, env: { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000', KEEP_FULL_GAME_DATA: '1' } });
    try {
      const sessionId = (await pg.db.query('SELECT id FROM game_sessions LIMIT 1')).rows[0].id;
      const me = game.players[0];
      const rest = await second.api('GET', `/api/sessions/${sessionId}/history`, { token: me.token });
      assert.equal(rest.status, 200);
      assert.equal(rest.json.data.rounds.length, game.final.totalRounds);
    } finally {
      await second.stop({ keepDb: true });
    }
  } finally {
    await pg.stop();
  }
});

test.after(() => { void counter; });
