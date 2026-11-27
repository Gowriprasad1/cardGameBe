'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connectSocket } = require('socket.io-client');

const { startTestServer, rid } = require('../helpers/server');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { await srv.stop(); });

const code = (res) => res.error && res.error.code;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

test('GET /api/health checks the database', async () => {
  const r = await srv.api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, data: { status: 'up' } });
});

test('GET /api/games lists SET with player limits', async () => {
  const r = await srv.api('GET', '/api/games');
  assert.deepEqual(r.json.data.games, [
    { code: 'SET', name: 'Set Game', minPlayers: 2, maxPlayers: 5 },
    { code: 'RUMMY', name: 'Indian Rummy', minPlayers: 2, maxPlayers: 5 },
  ]);
});

test('POST /api/guests creates a guest, stores only a hash of the token', async () => {
  const r = await srv.api('POST', '/api/guests', { body: { nickname: 'Asha' } });
  assert.equal(r.status, 201);
  const { userId, token, nickname } = r.json.data;
  assert.equal(nickname, 'Asha');
  assert.ok(token.length >= 40);
  const row = (await srv.db.query('SELECT token_hash FROM users WHERE id = $1', [userId])).rows[0];
  assert.notEqual(row.token_hash, token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('guest nickname is validated', async () => {
  for (const nickname of ['', 'a', 'x'.repeat(31), '<script>', 123]) {
    const r = await srv.api('POST', '/api/guests', { body: { nickname } });
    assert.equal(r.status, 400, `nickname ${JSON.stringify(nickname)}`);
    assert.equal(r.json.error.code, 'VALIDATION_FAILED');
  }
  const bad = await srv.api('POST', '/api/guests', { headers: { 'Content-Type': 'application/json' }, body: undefined });
  assert.equal(bad.status, 400);
});

test('malformed JSON and unknown routes use the standard error shape', async () => {
  const res = await fetch(`${srv.base}/api/guests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'VALIDATION_FAILED');
  const r = await srv.api('GET', '/api/nothing-here');
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
});

test('GET /api/me needs a valid token', async () => {
  assert.equal((await srv.api('GET', '/api/me')).status, 401);
  assert.equal((await srv.api('GET', '/api/me', { token: 'x'.repeat(43) })).status, 401);
  const p = await srv.player('Meera');
  const me = await srv.api('GET', '/api/me', { token: p.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.data, { userId: p.userId, nickname: 'Meera', activeRoomCode: null });
});

test('security headers are set and CORS only allows the configured frontend', async () => {
  const ok = await srv.api('GET', '/api/health', { headers: { Origin: 'http://localhost:4200' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('x-powered-by'), null);
  const evil = await srv.api('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('Socket.IO handshake only allows the configured frontend origin (browser CORS)', async () => {
  const url = `${srv.base}/socket.io/?EIO=4&transport=polling`;
  const allowed = await fetch(url, { headers: { Origin: 'http://localhost:4200' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  const denied = await fetch(url, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('guest creation and room lookups are rate limited', async () => {
  const limited = await startTestServer({ env: { RATE_LIMIT_STRICT: '5', RATE_LIMIT_API: '100000' } });
  try {
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await limited.api('POST', '/api/guests', { body: { nickname: `Spam ${i}` } })).status);
    }
    assert.deepEqual(statuses.slice(0, 5), [201, 201, 201, 201, 201]);
    assert.ok(statuses.slice(5).every((s) => s === 429), 'a flood of sign-ups must be limited');
    const blocked = await limited.api('POST', '/api/guests', { body: { nickname: 'Spam X' } });
    assert.equal(blocked.json.error.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    await limited.stop();
  }
});

// ---------------------------------------------------------------------------
// socket authentication
// ---------------------------------------------------------------------------

test('sockets without a valid token are refused', async () => {
  for (const auth of [{}, { token: 'nope' }, { token: 'x'.repeat(43) }]) {
    const socket = connectSocket(srv.base, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    const err = await new Promise((resolve) => socket.once('connect_error', resolve));
    assert.equal(err.message, 'UNAUTHENTICATED');
    socket.close();
  }
});

test('payloads are validated and identity cannot be forged', async () => {
  const a = await srv.player('Valid A');
  assert.equal(code(await a.client.emit('join-room', { roomCode: '!!' })), 'VALIDATION_FAILED');
  assert.equal(code(await a.client.emit('join-room', {})), 'VALIDATION_FAILED');
  assert.equal(code(await a.client.emit('draw-card', { requestId: 'short', source: 'draw' })), 'VALIDATION_FAILED');
  assert.equal(code(await a.client.emit('draw-card', { requestId: rid(), source: 'steal' })), 'VALIDATION_FAILED');
  assert.equal(code(await a.client.emit('discard-card', { requestId: rid(), cardId: 'ace of spades' })), 'VALIDATION_FAILED');
  // not in a room: every game action is refused, even with a forged player id
  assert.equal(code(await a.client.emit('draw-card', { requestId: rid(), source: 'draw', playerId: 'someone-else' })), 'NOT_IN_ROOM');
  assert.equal(code(await a.client.emit('start-game', {})), 'NOT_IN_ROOM');
  assert.equal(code(await a.client.emit('resume', {})), 'NOT_IN_ROOM');
});

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------

test('create room: unique code, creator is host in seat 0, shown in waiting room data', async () => {
  const host = await srv.player('Host One');
  const res = await host.client.emit('create-room', {});
  assert.equal(res.ok, true);
  const { roomCode, room } = res.data;
  assert.match(roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(room.status, 'waiting');
  assert.equal(room.hostId, host.userId);
  assert.equal(room.maxPlayers, 5);
  assert.deepEqual(room.players.map((p) => [p.nickname, p.seat, p.isHost, p.isConnected]), [['Host One', 0, true, true]]);

  const preview = await srv.api('GET', `/api/rooms/${roomCode}`);
  assert.deepEqual(preview.json.data, {
    roomCode, gameType: 'SET', status: 'waiting', playerCount: 1, maxPlayers: 5, eliminationPoints: 201, jokerMode: 'open', joinable: true,
  });
  const me = await srv.api('GET', '/api/me', { token: host.token });
  assert.equal(me.json.data.activeRoomCode, roomCode);

  // a second room for the same person is refused (no duplicate entries)
  const again = await host.client.emit('create-room', {});
  assert.equal(code(again), 'ALREADY_IN_ROOM');
  assert.equal(again.error.details.roomCode, roomCode);
});

test('room codes are unique across many rooms', async () => {
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    const p = await srv.player(`Many ${i}`);
    const res = await p.client.emit('create-room', {});
    assert.ok(!seen.has(res.data.roomCode));
    seen.add(res.data.roomCode);
  }
});

test('join room: everyone is told in real time, duplicates are impossible', async () => {
  const host = await srv.player('Hana');
  const guest = await srv.player('Gita');
  const { roomCode } = (await host.client.emit('create-room', {})).data;

  const mark = host.client.mark();
  const joined = await guest.client.emit('join-room', { roomCode });
  assert.equal(joined.ok, true);
  assert.equal(joined.data.rejoined, false);
  assert.deepEqual(joined.data.room.players.map((p) => [p.nickname, p.seat]), [['Hana', 0], ['Gita', 1]]);

  const evt = await host.client.waitFor('player-joined', { after: mark });
  assert.deepEqual([evt.payload.nickname, evt.payload.seat], ['Gita', 1]);
  const updated = await host.client.waitFor('room-updated', { after: mark, where: (r) => r.playerCount === 2 });
  assert.equal(updated.payload.players.length, 2);

  // joining again is idempotent, and the database has exactly one row per player
  const again = await guest.client.emit('join-room', { roomCode });
  assert.equal(again.data.rejoined, true);
  assert.equal(again.data.room.players.length, 2);
  const rows = (await srv.db.query(
    'SELECT count(*)::int AS n FROM room_players rp JOIN game_rooms r ON r.id = rp.room_id WHERE r.room_code = $1', [roomCode],
  )).rows[0];
  assert.equal(rows.n, 2);
});

test('join room: unknown code, lowercase code accepted, and being in another room is refused', async () => {
  const a = await srv.player('Ina');
  const b = await srv.player('Ivy');
  assert.equal(code(await a.client.emit('join-room', { roomCode: 'ZZZZZZ' })), 'ROOM_NOT_FOUND');
  assert.equal((await srv.api('GET', '/api/rooms/ZZZZZZ')).status, 404);
  const { roomCode } = (await a.client.emit('create-room', {})).data;
  assert.equal((await b.client.emit('join-room', { roomCode: roomCode.toLowerCase() })).ok, true);
  const c = await srv.player('Ian');
  const other = (await c.client.emit('create-room', {})).data.roomCode;
  assert.equal(code(await b.client.emit('join-room', { roomCode: other })), 'ALREADY_IN_ROOM');
});

test('a room holds at most 5 players', async () => {
  const host = await srv.player('Cap Host');
  const { roomCode } = (await host.client.emit('create-room', {})).data;
  for (let i = 1; i < 5; i += 1) {
    const p = await srv.player(`Cap ${i}`);
    assert.equal((await p.client.emit('join-room', { roomCode })).ok, true);
  }
  const sixth = await srv.player('Cap Six');
  assert.equal(code(await sixth.client.emit('join-room', { roomCode })), 'ROOM_FULL');
  const preview = await srv.api('GET', `/api/rooms/${roomCode}`);
  assert.deepEqual([preview.json.data.playerCount, preview.json.data.joinable], [5, false]);
});

test('only the host can start, and at least 2 players are needed', async () => {
  const host = await srv.player('Start Host');
  const guest = await srv.player('Start Guest');
  const { roomCode } = (await host.client.emit('create-room', {})).data;
  assert.equal(code(await host.client.emit('start-game', {})), 'NOT_ENOUGH_PLAYERS');
  await guest.client.emit('join-room', { roomCode });
  assert.equal(code(await guest.client.emit('start-game', {})), 'NOT_HOST');
  assert.equal((await host.client.emit('start-game', {})).ok, true);
  assert.equal(code(await host.client.emit('start-game', {})), 'ROOM_STARTED');
});

test('after the start the player list is frozen; leaving mid-game is the Exit (for good, the game goes on or ends)', async () => {
  const host = await srv.player('Frozen Host');
  const guest = await srv.player('Frozen Guest');
  const third = await srv.player('Frozen Third');
  const late = await srv.player('Frozen Late');
  const { roomCode } = (await host.client.emit('create-room', {})).data;
  await guest.client.emit('join-room', { roomCode });
  await third.client.emit('join-room', { roomCode });
  await host.client.emit('start-game', {});

  assert.equal(code(await late.client.emit('join-room', { roomCode })), 'ROOM_STARTED');
  const preview = await srv.api('GET', `/api/rooms/${roomCode}`);
  assert.deepEqual([preview.json.data.status, preview.json.data.joinable], ['in_progress', false]);
  // with three players, one leaving does not end the game
  assert.equal((await guest.client.emit('leave-room', {})).ok, true);
  assert.equal(code(await guest.client.emit('join-room', { roomCode })), 'LEFT_GAME');
  const status = (await srv.db.query('SELECT status FROM game_rooms WHERE room_code = $1', [roomCode])).rows[0].status;
  assert.equal(status, 'in_progress');
});

test('leaving the waiting room frees the seat and hands the host role on', async () => {
  const host = await srv.player('Leave Host');
  const guest = await srv.player('Leave Guest');
  const { roomCode } = (await host.client.emit('create-room', {})).data;
  await guest.client.emit('join-room', { roomCode });

  const mark = guest.client.mark();
  assert.equal((await host.client.emit('leave-room', {})).data.left, true);
  const left = await guest.client.waitFor('player-left', { after: mark });
  assert.equal(left.payload.playerId, host.userId);
  const updated = await guest.client.waitFor('room-updated', { after: mark });
  assert.equal(updated.payload.hostId, guest.userId);
  assert.equal(updated.payload.players.length, 1);

  // the leaver can create or join elsewhere again
  assert.equal((await host.client.emit('join-room', { roomCode })).ok, true);

  // last player leaving closes the room
  await host.client.emit('leave-room', {});
  await guest.client.emit('leave-room', {});
  const row = (await srv.db.query('SELECT status FROM game_rooms WHERE room_code = $1', [roomCode])).rows[0];
  assert.equal(row.status, 'abandoned');
  assert.equal((await srv.api('GET', `/api/rooms/${roomCode}`)).status, 404);
});

for (const n of [2, 3, 4, 5]) {
  test(`${n}-player room starts a game: everyone gets 13 private cards, dealer chosen by the server`, async () => {
    const players = [];
    for (let i = 0; i < n; i += 1) players.push(await srv.player(`Room${n} P${i}`));
    const { roomCode } = (await players[0].client.emit('create-room', {})).data;
    for (const p of players.slice(1)) await p.client.emit('join-room', { roomCode });
    assert.equal((await players[0].client.emit('start-game', {})).ok, true);

    for (const p of players) {
      const dealer = await p.client.waitFor('dealer-selected');
      assert.ok(players.some((x) => x.userId === dealer.payload.dealerId));
      const state = await p.client.waitFor('game-state');
      assert.equal(state.payload.me.hand.length, 13);
      assert.equal(state.payload.deckCount, n === 2 ? 1 : 2);
      assert.ok(state.payload.players.every((x) => x.handCount === 13));
    }
    // every client got a different hand and never saw anybody else's cards
    const hands = players.map((p) => p.client.lastState().me.hand.map((c) => c.id));
    for (let i = 0; i < n; i += 1) {
      const logJson = JSON.stringify(players[i].client.events);
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        for (const id of hands[j]) assert.ok(!logJson.includes(`"${id}"`), `player ${i} saw a card of player ${j}`);
      }
    }
  });
}

test('GET /api/live is a cheap probe: no database, no rate limit, no extra headers leaked', async () => {
  const r = await srv.api('GET', '/api/live');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, data: { status: 'live' } });
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('stale guests who never played are removed; guests with a seat are kept', async () => {
  const lonely = (await srv.api('POST', '/api/guests', { body: { nickname: 'Lonely Guest' } })).json.data;
  const host = await srv.player('Seated Guest');
  await host.client.emit('create-room', {});
  await srv.db.query("UPDATE users SET last_seen_at = now() - interval '200 days' WHERE id = ANY($1::uuid[])", [[lonely.userId, host.userId]]);
  const removed = await require('../../src/db/repositories/users.repository').purgeStaleGuests(srv.db, 90);
  assert.ok(removed >= 1);
  const left = (await srv.db.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [[lonely.userId, host.userId]])).rows.map((r) => r.id);
  assert.deepEqual(left, [host.userId]);
});

test('the host chooses the points at which a player is out: 101, 201 (default) or 301', async () => {
  const make = async (nick, payload) => {
    const p = await srv.player(nick);
    return { p, res: await p.client.emit('create-room', payload) };
  };
  const standard = await make('Pts Default', {});
  assert.equal(standard.res.data.room.eliminationPoints, 201);
  assert.equal((await srv.api('GET', `/api/rooms/${standard.res.data.roomCode}`)).json.data.eliminationPoints, 201);

  for (const points of [101, 201, 301]) {
    const { p, res } = await make(`Pts ${points}`, { points });
    assert.equal(res.ok, true);
    assert.equal(res.data.room.eliminationPoints, points);
    const joiner = await srv.player(`Pts join ${points}`);
    const joined = await joiner.client.emit('join-room', { roomCode: res.data.roomCode });
    assert.equal(joined.data.room.eliminationPoints, points, 'everyone who joins sees the same limit');
    await p.client.emit('start-game', {});
    const state = await joiner.client.waitFor('game-state');
    assert.equal(state.payload.config.eliminationThreshold, points, 'the game really uses it');
    const row = (await srv.db.query('SELECT config FROM game_rooms WHERE room_code = $1', [res.data.roomCode])).rows[0];
    assert.equal(row.config.eliminationThreshold, points, 'and it is saved with the room');
  }

  for (const bad of [150, 0, 1000, '201', true]) {
    const { res } = await make(`Pts bad ${String(bad)}`, { points: bad });
    assert.equal(res.ok, false, `points ${JSON.stringify(bad)} must be refused`);
    assert.equal(res.error.code, 'VALIDATION_FAILED');
    assert.equal(res.error.details.field, 'points');
  }
});
