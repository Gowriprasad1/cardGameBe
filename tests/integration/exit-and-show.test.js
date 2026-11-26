'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, rid } = require('../helpers/server');
const { rigHands, groupIds, setOpenJoker } = require('../helpers/cards');

const FAST = { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000' };
const VALID_HAND = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C';
const VALID_GROUPS = ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C'];
const P2 = '5H 5D 5C 5S 6H 6D 6C 2H 2D 2C 3H 3D KH'; // 16 points at best
const P3 = '4H 4D 4C 4S QH QD QC JH JD 3C 3S 9H/2 9D/2'; // 44 points at best

async function startRoom(srv, count, label) {
  const players = [];
  for (let i = 0; i < count; i += 1) players.push(await srv.player(`${label}${i}`));
  const { roomCode } = (await players[0].client.emit('create-room', {})).data;
  for (const p of players.slice(1)) assert.equal((await p.client.emit('join-room', { roomCode })).ok, true);
  assert.equal((await players[0].client.emit('start-game', {})).ok, true);
  for (const p of players) await p.client.waitFor('game-state');
  return { players, roomCode, live: () => srv.container.gameSessions.live.get(roomCode) };
}

const code = (res) => res && res.error && res.error.code;

test('Exit during a game: out for good with no points, the others play on, it is saved, and there is no way back in', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const { players, roomCode, live } = await startRoom(srv, 3, 'Exit');
    const [a, b, c] = players;
    live().state.round.currentPlayerId = a.userId;
    const mark = b.client.mark();

    const res = await c.client.emit('leave-room', {});
    assert.equal(res.ok, true, JSON.stringify(res));
    const left = await b.client.waitFor('player-left-game', { after: mark });
    assert.equal(left.payload.playerId, c.userId);
    const roomUpdate = await b.client.waitFor('room-updated', { after: mark, where: (r) => r.players.some((p) => p.playerId === c.userId && p.status === 'left') });
    assert.ok(roomUpdate);

    // the one who left is free again, and cannot come back to this game
    const me = await srv.api('GET', '/api/me', { token: c.token });
    assert.equal(me.json.data.activeRoomCode, null);
    assert.equal(code(await c.client.emit('join-room', { roomCode })), 'LEFT_GAME');
    assert.equal(code(await c.client.emit('draw-card', { requestId: rid(), source: 'draw' })), 'NOT_IN_ROOM');

    // saved at once
    const seat = (await srv.db.query(
      `SELECT rp.status FROM room_players rp JOIN game_rooms r ON r.id = rp.room_id JOIN users u ON u.id = rp.user_id
        WHERE r.room_code = $1 AND u.id = $2`, [roomCode, c.userId])).rows[0];
    assert.equal(seat.status, 'left');

    // the round carries on: a drops, b is last standing; c is recorded with 0 points as "left"
    assert.equal((await a.client.emit('player-drop', { requestId: rid() })).ok, true);
    const done = await b.client.waitFor('round-completed', { after: mark });
    assert.equal(done.payload.winnerId, b.userId);
    const row = done.payload.results.find((r) => r.playerId === c.userId);
    assert.deepEqual([row.penalty, row.reason, row.roundStatus], [0, 'left', 'left']);
    const scores = (await srv.db.query(
      `SELECT ps.reason, ps.penalty FROM player_scores ps JOIN game_rounds gr ON gr.id = ps.round_id
         JOIN game_sessions s ON s.id = gr.session_id JOIN game_rooms r ON r.id = s.room_id
        WHERE r.room_code = $1 AND ps.reason = 'left'`, [roomCode])).rows;
    assert.deepEqual(scores, [{ reason: 'left', penalty: 0 }], 'migration 003 accepts the "left" reason');
  } finally {
    await srv.stop();
  }
});

test('Exit in a two-player game: the other player wins the game', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const { players } = await startRoom(srv, 2, 'Exit2');
    const [a, b] = players;
    const mark = a.client.mark();
    assert.equal((await b.client.emit('leave-room', {})).ok, true);
    const over = await a.client.waitFor('game-completed', { after: mark });
    assert.equal(over.payload.winnerId, a.userId);
  } finally {
    await srv.stop();
  }
});

test('after a valid declaration the others get a show window; submitting early or the timer ends it, points are the best possible', async () => {
  const srv = await startTestServer({ env: { ...FAST, SHOW_WINDOW_SECONDS: '2' } });
  try {
    const { players, live } = await startRoom(srv, 3, 'Show');
    const [a, b, c] = players;
    setOpenJoker(live().state, 'A');
    rigHands(live().state, { [a.userId]: VALID_HAND, [b.userId]: P2, [c.userId]: P3 });
    live().state.round.currentPlayerId = a.userId;
    const mark = b.client.mark();

    const res = await a.client.emit('declare-game', { requestId: rid(), groups: groupIds(VALID_GROUPS) });
    assert.equal(res.ok, true, JSON.stringify(res));
    const started = await c.client.waitFor('show-started', { after: mark });
    assert.equal(started.payload.declarerId, a.userId);
    assert.equal(started.payload.reveal.cards.length, 13, 'everyone sees the shown hand');
    const view = (await c.client.waitFor('game-state', { after: mark, where: (v) => v.round && v.round.phase === 'showing' })).payload;
    assert.equal(view.me.canSubmitShow, true);
    assert.ok(view.showDeadlineAt > Date.now(), 'the show window has a deadline');

    // b submits (with every card loose: it must not cost anything); c never does, so the timer ends the show
    const bView = (await b.client.waitFor('game-state', { after: mark, where: (v) => v.round && v.round.phase === 'showing' })).payload;
    const loose = bView.me.hand.map((x) => [x.id]);
    const submitted = await b.client.emit('submit-show', { requestId: rid(), groups: loose });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.data.view.showDeadlineAt, view.showDeadlineAt, 'submitting never restarts the show timer');
    const done = await a.client.waitFor('round-completed', { after: mark, timeout: 6000 });
    assert.equal(done.payload.winnerId, a.userId);
    const pts = Object.fromEntries(done.payload.results.map((r) => [r.playerId, r.penalty]));
    assert.deepEqual([pts[a.userId], pts[b.userId], pts[c.userId]], [0, 16, 44]);
  } finally {
    await srv.stop();
  }
});
