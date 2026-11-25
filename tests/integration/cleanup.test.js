'use strict';

/**
 * When a game ends only its RESULT is kept. The cards, the action log and the
 * saved game state are deleted. Old finished rooms are removed after the
 * retention period.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../helpers/server');
const { attachBot } = require('../helpers/socket-bot');
const { purgeOldRooms } = require('../../src/db/repositories/sessions.repository');

const FAST = { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000' };

async function playShortGame(srv, label) {
  const players = [await srv.player(`${label}A`), await srv.player(`${label}B`)];
  const { roomCode } = (await players[0].client.emit('create-room', {})).data;
  await players[1].client.emit('join-room', { roomCode });
  players.forEach((p, i) => attachBot(p.client, { maxTurns: 6, quitsFirst: i === 0 }));
  await players[0].client.emit('start-game', {});
  const done = await Promise.all(players.map((p) => p.client.waitFor('game-completed', { timeout: 120000 })));
  return { players, roomCode, final: done[0].payload };
}

const count = async (srv, sql, params = []) => (await srv.db.query(sql, params)).rows[0].n;

test('after a game: the result stays, cards, action log and saved state are deleted', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const { players, roomCode, final } = await playShortGame(srv, 'Clean');
    const session = (await srv.db.query(
      `SELECT s.id, s.status, s.state_snapshot FROM game_sessions s JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode])).rows[0];
    assert.equal(session.status, 'completed');
    assert.equal(session.state_snapshot, null, 'saved game state is gone');

    const sid = session.id;
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM game_actions WHERE session_id = $1', [sid]), 0);
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM card_decks cd JOIN game_rounds gr ON gr.id = cd.round_id WHERE gr.session_id = $1', [sid]), 0);
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM player_cards pc JOIN game_rounds gr ON gr.id = pc.round_id WHERE gr.session_id = $1', [sid]), 0);

    // what must remain: the final result and the round-by-round scores
    const history = (await srv.db.query('SELECT winner_user_id, total_rounds, final_scoreboard FROM game_history WHERE session_id = $1', [sid])).rows;
    assert.equal(history.length, 1);
    assert.equal(history[0].winner_user_id, final.winnerId);
    assert.equal(history[0].total_rounds, final.totalRounds);
    assert.equal(history[0].final_scoreboard.length, 2);
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM game_rounds WHERE session_id = $1', [sid]), final.totalRounds);
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM player_scores WHERE session_id = $1', [sid]), 2 * final.totalRounds);

    // players still see the final result: in the live game, and over REST
    const resumed = await players[1].client.emit('resume', {});
    assert.equal(resumed.data.view.stage, 'completed');
    assert.equal(resumed.data.view.winnerId, final.winnerId);
    const rest = await srv.api('GET', `/api/sessions/${sid}/history`, { token: players[0].token });
    assert.equal(rest.json.data.rounds.length, final.totalRounds);
  } finally {
    await srv.stop();
  }
});

test('KEEP_FULL_GAME_DATA=1 keeps everything for debugging', async () => {
  const srv = await startTestServer({ env: { ...FAST, KEEP_FULL_GAME_DATA: '1' } });
  try {
    const { roomCode } = await playShortGame(srv, 'Keep');
    const sid = (await srv.db.query('SELECT s.id FROM game_sessions s JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1', [roomCode])).rows[0].id;
    assert.ok(await count(srv, 'SELECT count(*)::int AS n FROM game_actions WHERE session_id = $1', [sid]) > 0);
    assert.ok(await count(srv, 'SELECT count(*)::int AS n FROM card_decks cd JOIN game_rounds gr ON gr.id = cd.round_id WHERE gr.session_id = $1', [sid]) > 0);
  } finally {
    await srv.stop();
  }
});

test('an idle in-progress room that is abandoned also loses its working data', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const a = await srv.player('IdleA');
    const b = await srv.player('IdleB');
    const { roomCode } = (await a.client.emit('create-room', {})).data;
    await b.client.emit('join-room', { roomCode });
    await a.client.emit('start-game', {});
    await a.client.waitFor('game-state');
    a.client.socket.close();
    b.client.socket.close();
    for (let i = 0; i < 100 && (srv.container.presence.isConnected(a.userId) || srv.container.presence.isConnected(b.userId)); i += 1) await new Promise((r) => setTimeout(r, 20));
    await srv.container.rooms.sweepIdle(Date.now() + 31 * 60 * 1000);
    const row = (await srv.db.query(
      `SELECT s.id, s.status, s.state_snapshot, r.status AS room_status FROM game_sessions s JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode])).rows[0];
    assert.deepEqual([row.status, row.room_status, row.state_snapshot], ['abandoned', 'abandoned', null]);
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM card_decks cd JOIN game_rounds gr ON gr.id = cd.round_id WHERE gr.session_id = $1', [row.id]), 0);
  } finally {
    await srv.stop();
  }
});

test('retention: finished and abandoned rooms older than the limit are deleted completely, newer ones stay', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const oldGame = await playShortGame(srv, 'Old');
    const newGame = await playShortGame(srv, 'New');
    const waiting = await srv.player('WaitX');
    const { roomCode: waitCode } = (await waiting.client.emit('create-room', {})).data; // still open: must never be touched

    await srv.db.query("UPDATE game_rooms SET finished_at = now() - interval '40 days' WHERE room_code = $1", [oldGame.roomCode]);
    await srv.db.query("UPDATE game_rooms SET finished_at = now() - interval '2 days' WHERE room_code = $1", [newGame.roomCode]);

    const removed = await purgeOldRooms(srv.db, 30);
    assert.equal(removed, 1);
    const rooms = (await srv.db.query('SELECT room_code FROM game_rooms WHERE room_code = ANY($1::text[])', [[oldGame.roomCode, newGame.roomCode, waitCode]])).rows.map((r) => r.room_code).sort();
    assert.deepEqual(rooms, [newGame.roomCode, waitCode].sort());
    // nothing of the old game is left anywhere
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM game_history WHERE winner_user_id = $1', [oldGame.final.winnerId]), 0);
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM room_players WHERE user_id = ANY($1::uuid[])', [oldGame.players.map((p) => p.userId)]), 0);
    // the newer game's result is intact
    assert.equal(await count(srv, 'SELECT count(*)::int AS n FROM game_history WHERE winner_user_id = $1', [newGame.final.winnerId]), 1);
    assert.equal(await purgeOldRooms(srv.db, 30), 0, 'a second run finds nothing');
  } finally {
    await srv.stop();
  }
});
