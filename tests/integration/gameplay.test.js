'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, rid } = require('../helpers/server');
const { rigHands, setOpenJoker, groupIds } = require('../helpers/cards');
const { createBucket } = require('../../src/socket');

const VALID_HAND = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C';
const VALID_GROUPS = ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C'];
const JUNK_1 = '2H 3H 4H 5H 6H JH QH KS 2D 3D 4D 5D 6D'; // no groups, 70 points
const JUNK_2 = '2H/2 3H/2 4H/2 5H/2 6H/2 JH/2 QH/2 KS/2 2D/2 3D/2 4D/2 5D/2 6D/2';

const errCode = (res) => res.error && res.error.code;

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { await srv.stop(); });

let n = 0;
const nick = (label) => `${label} ${(n += 1)}`;

/** Create a room with `count` players and start the game. */
async function startRoom(count) {
  const players = [];
  for (let i = 0; i < count; i += 1) players.push(await srv.player(nick(`Gamer${i}`)));
  const { roomCode } = (await players[0].client.emit('create-room', {})).data;
  for (const p of players.slice(1)) await p.client.emit('join-room', { roomCode });
  assert.equal((await players[0].client.emit('start-game', {})).ok, true);
  for (const p of players) await p.client.waitFor('game-state');
  return { players, roomCode, live: () => srv.container.gameSessions.live.get(roomCode) };
}

/** Wait until every client has seen at least this state version. */
const settle = (players, version) => Promise.all(players.map((p) => (
  p.client.waitFor('game-state', { where: (s) => s.version >= version }))));

const current = (players) => players.find((p) => p.client.lastState().round.currentPlayerId === p.userId);
const others = (players, who) => players.filter((p) => p !== who);

async function playTurn(players, who = current(players)) {
  const drawn = await who.client.emit('draw-card', { requestId: rid(), source: 'draw' });
  assert.equal(drawn.ok, true, JSON.stringify(drawn));
  const hand = who.client.lastState().me.hand;
  const discarded = await who.client.emit('discard-card', { requestId: rid(), cardId: hand[0].id });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  await settle(players, discarded.data.view.version);
}

/** Give players exact hands in the live server state (test-only shortcut for scenarios). */
function rig(live, byUserId, { current: cur, openJoker = 'A' } = {}) {
  setOpenJoker(live.state, openJoker);
  rigHands(live.state, byUserId);
  if (cur) live.state.round.currentPlayerId = cur;
}

const rows = async (sql, params = []) => (await srv.db.query(sql, params)).rows;

// ---------------------------------------------------------------------------

test('a full turn over sockets: draw, discard, turn passes, counts stay right', async () => {
  const { players } = await startRoom(2);
  const first = current(players);
  const second = others(players, first)[0];
  const startVersion = first.client.lastState().version;
  assert.equal(first.client.lastState().round.drawPileCount, 54 - 1 - 26 - 1);

  // the other player cannot act out of turn
  const early = await second.client.emit('draw-card', { requestId: rid(), source: 'draw' });
  assert.equal(errCode(early), 'NOT_YOUR_TURN');
  assert.equal((await second.client.emit('player-drop', { requestId: rid() })).error.code, 'NOT_YOUR_TURN');

  // discarding first, or discarding a card you do not hold, is refused
  assert.equal(errCode(await first.client.emit('discard-card', { requestId: rid(), cardId: first.client.lastState().me.hand[0].id })), 'MUST_DRAW_FIRST');

  const draw = await first.client.emit('draw-card', { requestId: rid(), source: 'draw' });
  assert.equal(draw.ok, true);
  assert.equal(draw.data.view.me.hand.length, 14);
  assert.equal(errCode(await first.client.emit('draw-card', { requestId: rid(), source: 'draw' })), 'ALREADY_DRAWN');
  const foreign = second.client.lastState().me.hand[0].id;
  assert.equal(errCode(await first.client.emit('discard-card', { requestId: rid(), cardId: foreign })), 'CARD_NOT_IN_HAND');

  const mine = first.client.lastState().me.hand[0].id;
  const done = await first.client.emit('discard-card', { requestId: rid(), cardId: mine });
  assert.equal(done.ok, true);
  await settle(players, done.data.view.version);
  assert.equal(first.client.lastState().me.hand.length, 13);
  assert.equal(second.client.lastState().round.currentPlayerId, second.userId);
  assert.equal(second.client.lastState().round.discardTop.id, mine);
  assert.equal(second.client.lastState().round.drawPileCount, 54 - 1 - 26 - 1 - 1);
  assert.equal(first.client.lastState().version, startVersion + 2);

  // the next player is told it is their turn, with a deadline
  const turn = await second.client.waitFor('player-turn', { where: (t) => t.playerId === second.userId });
  assert.equal(turn.payload.playerId, second.userId);
  assert.ok('deadlineAt' in turn.payload);
});

test('every accepted action is saved: actions log and a snapshot that matches memory', async () => {
  const { players, roomCode, live } = await startRoom(2);
  await playTurn(players);
  const session = (await rows(
    `SELECT s.id, s.state_version, s.state_snapshot, s.status FROM game_sessions s
       JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode]))[0];
  assert.equal(session.status, 'in_progress');
  assert.equal(Number(session.state_version), live().state.version);
  assert.equal(session.state_snapshot.version, live().state.version);
  const actions = await rows('SELECT action_type FROM game_actions WHERE session_id = $1 ORDER BY id', [session.id]);
  assert.deepEqual(actions.map((a) => a.action_type), ['draw', 'discard']);

  // round 1 is dealt and stored in full: every physical card exists exactly once
  const decks = await rows(
    `SELECT count(*)::int AS cards, count(DISTINCT instance_id)::int AS unique_cards FROM card_decks cd
       JOIN game_rounds gr ON gr.id = cd.round_id WHERE gr.session_id = $1`, [session.id]);
  assert.deepEqual(decks[0], { cards: 54, unique_cards: 54 });
  const hands = await rows(
    `SELECT count(*)::int AS n FROM player_cards pc JOIN game_rounds gr ON gr.id = pc.round_id WHERE gr.session_id = $1`, [session.id]);
  assert.equal(hands[0].n, 26);
});

test('opponents never receive each other\'s cards, over a whole sequence of turns', async () => {
  const { players } = await startRoom(3);
  const everyHand = new Map();
  const remember = () => players.forEach((p) => {
    const id = p.userId;
    const set = everyHand.get(id) || new Set();
    p.client.lastState().me.hand.forEach((c) => set.add(c.id));
    everyHand.set(id, set);
  });
  remember();
  for (let i = 0; i < 6; i += 1) { await playTurn(players); remember(); }

  // Cards that were ever private to one player must not appear in other clients' logs,
  // except when they were discarded face-up (public by the rules).
  const publicIds = new Set();
  for (const p of players) {
    for (const e of p.client.events) {
      if (e.name === 'card-discarded') publicIds.add(e.payload.card.id);
      if (e.name === 'card-drawn' && e.payload.card) publicIds.add(e.payload.card.id);
      if (e.name === 'cards-distributed') {
        publicIds.add(e.payload.openJokerCard.id);
        publicIds.add(e.payload.discardTop.id);
      }
    }
  }
  for (const viewer of players) {
    const log = JSON.stringify(viewer.client.events);
    for (const owner of players) {
      if (owner === viewer) continue;
      for (const id of everyHand.get(owner.userId)) {
        if (publicIds.has(id)) continue;
        assert.ok(!log.includes(`"${id}"`), `${viewer.nickname} saw private card ${id} of ${owner.nickname}`);
      }
    }
  }
  assert.ok(players.every((p) => p.client.all('game-state').every((s) => !('drawPile' in s) && !('hands' in s))));
});

test('first drop: 20 points, round settles, scores and results are stored in one go', async () => {
  const { players, roomCode } = await startRoom(2);
  const dropper = current(players);
  const winner = others(players, dropper)[0];
  const res = await dropper.client.emit('player-drop', { requestId: rid() });
  assert.equal(res.ok, true);

  const drop = await winner.client.waitFor('player-drop');
  assert.deepEqual([drop.payload.playerId, drop.payload.type, drop.payload.penalty], [dropper.userId, 'first', 20]);
  const done = await winner.client.waitFor('round-completed');
  assert.equal(done.payload.winnerId, winner.userId);
  assert.equal(done.payload.endReason, 'last_player_standing');
  const board = await winner.client.waitFor('scoreboard-updated');
  const mine = board.payload.scoreboard.find((s) => s.playerId === dropper.userId);
  assert.deepEqual([mine.cumulativeScore, mine.drops], [20, 1]);

  const scores = await rows(
    `SELECT u.nickname, ps.reason, ps.penalty, ps.cumulative_after FROM player_scores ps
       JOIN room_players rp ON rp.id = ps.room_player_id JOIN users u ON u.id = rp.user_id
       JOIN game_rounds gr ON gr.id = ps.round_id JOIN game_sessions s ON s.id = gr.session_id
       JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1 ORDER BY ps.penalty DESC`, [roomCode]);
  assert.deepEqual(scores.map((s) => [s.reason, s.penalty, s.cumulative_after]), [['first_drop', 20, 20], ['winner', 0, 0]]);
  const round = (await rows(
    `SELECT gr.status, gr.end_reason FROM game_rounds gr JOIN game_sessions s ON s.id = gr.session_id
       JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode]))[0];
  assert.deepEqual(round, { status: 'completed', end_reason: 'last_player_standing' });
  const totals = await rows(
    `SELECT cumulative_score, total_drops FROM room_players rp JOIN game_rooms r ON r.id = rp.room_id
      WHERE r.room_code = $1 AND rp.user_id = $2`, [roomCode, dropper.userId]);
  assert.deepEqual(totals[0], { cumulative_score: 20, total_drops: 1 });
});

test('middle drop costs 40 and a dropped player can no longer act', async () => {
  const { players } = await startRoom(3);
  const first = current(players);
  await playTurn(players);
  await playTurn(players);
  await playTurn(players); // everyone has now completed a turn
  assert.equal(current(players), first);
  const res = await first.client.emit('player-drop', { requestId: rid() });
  assert.equal(res.ok, true);
  const drop = await first.client.waitFor('player-drop');
  assert.deepEqual([drop.payload.type, drop.payload.penalty], ['middle', 40]);
  assert.equal(errCode(await first.client.emit('draw-card', { requestId: rid(), source: 'draw' })), 'NOT_IN_ROUND');
});

test('valid declaration over sockets: winner scores 0, the other pays unmatched cards, all stored', async () => {
  const { players, roomCode, live } = await startRoom(2);
  const [a, b] = players;
  rig(live(), { [a.userId]: VALID_HAND, [b.userId]: JUNK_1 }, { current: a.userId });
  const res = await a.client.emit('declare-game', { requestId: rid(), groups: groupIds(VALID_GROUPS) });
  assert.equal(res.ok, true, JSON.stringify(res));

  const done = await b.client.waitFor('round-completed');
  assert.equal(done.payload.winnerId, a.userId);
  assert.equal(done.payload.endReason, 'valid_declaration');
  const loser = done.payload.results.find((r) => r.playerId === b.userId);
  assert.deepEqual([loser.penalty, loser.reason], [70, 'no_life_hand']);
  assert.ok(done.payload.reveals[a.userId], 'the winner\'s groups are shown at round end');

  const stored = await rows(
    `SELECT ps.penalty, ps.reason, gr.end_reason FROM player_scores ps JOIN game_rounds gr ON gr.id = ps.round_id
       JOIN game_sessions s ON s.id = gr.session_id JOIN game_rooms r ON r.id = s.room_id
      WHERE r.room_code = $1 ORDER BY ps.penalty`, [roomCode]);
  assert.deepEqual(stored.map((s) => [s.penalty, s.reason, s.end_reason]), [[0, 'winner', 'valid_declaration'], [70, 'no_life_hand', 'valid_declaration']]);
  // final card positions are saved at round end
  const cards = await rows(
    `SELECT count(*)::int AS n FROM card_decks cd JOIN game_rounds gr ON gr.id = cd.round_id
       JOIN game_sessions s ON s.id = gr.session_id JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode]);
  assert.equal(cards[0].n, 54);
});

test('invalid declaration: exactly 40, announced to all, the reason is private to the declarer', async () => {
  const { players, live } = await startRoom(3);
  const [a, b, c] = players;
  rig(live(), { [a.userId]: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 10C JK1', [b.userId]: JUNK_1, [c.userId]: JUNK_2 }, { current: a.userId });
  const bad = groupIds(['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']); // no natural LIFE
  const markB = b.client.mark();
  const res = await a.client.emit('declare-game', { requestId: rid(), groups: bad });
  assert.equal(res.ok, true);

  for (const p of [a, b, c]) {
    const result = await p.client.waitFor('declaration-result');
    assert.deepEqual([result.payload.valid, result.payload.penalty], [false, 40]);
  }
  assert.equal(a.client.all('declaration-errors').length, 1);
  assert.equal(a.client.all('declaration-errors')[0].errors[0].code, 'NO_LIFE');
  assert.equal(b.client.all('declaration-errors').length, 0);
  assert.ok(!JSON.stringify(b.client.events.slice(markB)).includes('D1-JK-1'), 'the attempted groups are never shown to others');
  assert.equal(b.client.lastState().round.currentPlayerId !== a.userId, true);
  assert.equal(b.client.lastState().players.find((p) => p.playerId === a.userId).roundStatus, 'removed_invalid_declaration');
});

test('an invalid declaration that ends the round is stored completely (status values fit the schema)', async () => {
  const { players, roomCode, live } = await startRoom(2);
  const [a, b] = players;
  rig(live(), { [a.userId]: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 10C JK1', [b.userId]: JUNK_1 }, { current: a.userId });
  const bad = groupIds(['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']);
  const res = await a.client.emit('declare-game', { requestId: rid(), groups: bad });
  assert.equal(res.ok, true, JSON.stringify(res));
  const done = await b.client.waitFor('round-completed');
  assert.equal(done.payload.winnerId, b.userId);
  const stored = await rows(
    `SELECT rp.status, u.nickname FROM round_players rp JOIN room_players p ON p.id = rp.room_player_id
       JOIN users u ON u.id = p.user_id JOIN game_rounds gr ON gr.id = rp.round_id
       JOIN game_sessions s ON s.id = gr.session_id JOIN game_rooms r ON r.id = s.room_id
      WHERE r.room_code = $1 AND p.user_id = $2`, [roomCode, a.userId]);
  assert.equal(stored[0].status, 'removed_invalid_declaration');
  const score = await rows(
    `SELECT ps.penalty, ps.reason FROM player_scores ps JOIN room_players p ON p.id = ps.room_player_id
       JOIN game_rounds gr ON gr.id = ps.round_id JOIN game_sessions s ON s.id = gr.session_id
       JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1 AND p.user_id = $2`, [roomCode, a.userId]);
  assert.deepEqual(score[0], { penalty: 40, reason: 'invalid_declaration' });
});

test('reaching 201 ends the game: winner, history, room finished, nothing double counted', async () => {
  const { players, roomCode, live } = await startRoom(2);
  const [a, b] = players;
  rig(live(), { [a.userId]: VALID_HAND, [b.userId]: JUNK_1 }, { current: a.userId });
  live().state.players[b.userId].score = 185; // 185 + 70 = 255
  await a.client.emit('declare-game', { requestId: rid(), groups: groupIds(VALID_GROUPS) });

  const eliminated = await a.client.waitFor('player-eliminated');
  assert.equal(eliminated.payload.playerId, b.userId);
  assert.equal(eliminated.payload.cumulativeScore, 255);
  const done = await b.client.waitFor('game-completed');
  assert.equal(done.payload.winnerId, a.userId);
  assert.equal(done.payload.totalRounds, 1);
  assert.equal(done.payload.eliminatedHistory[0].playerId, b.userId);

  const history = (await rows(
    `SELECT gh.total_rounds, gh.winner_user_id, gh.final_scoreboard FROM game_history gh
       JOIN game_rooms r ON r.id = gh.room_id WHERE r.room_code = $1`, [roomCode]));
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].total_rounds, history[0].winner_user_id], [1, a.userId]);
  assert.equal(history[0].final_scoreboard.find((s) => s.playerId === b.userId).cumulativeScore, 255);
  const room = (await rows('SELECT status FROM game_rooms WHERE room_code = $1', [roomCode]))[0];
  assert.equal(room.status, 'finished');
  const eliminatedRow = (await rows(
    `SELECT rp.status, rp.cumulative_score, rp.eliminated_round_no FROM room_players rp
       JOIN game_rooms r ON r.id = rp.room_id WHERE r.room_code = $1 AND rp.user_id = $2`, [roomCode, b.userId]))[0];
  assert.deepEqual(eliminatedRow, { status: 'eliminated', cumulative_score: 255, eliminated_round_no: 1 });
  const sessionRow = (await rows(
    `SELECT s.status FROM game_sessions s JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode]))[0];
  assert.equal(sessionRow.status, 'completed');

  // after the game: actions are refused, and the score history is available over REST to participants only
  assert.equal(errCode(await a.client.emit('draw-card', { requestId: rid(), source: 'draw' })), 'GAME_FINISHED');
  const sessionId = a.client.lastState() && (await a.client.emit('resume', {})).data.room.sessionId;
  const rest = await srv.api('GET', `/api/sessions/${sessionId}/history`, { token: b.token });
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.json.data.rounds[0].scores.map((s) => s.penalty).sort((x, y) => x - y), [0, 70]);
  const outsider = await srv.player(nick('Outsider'));
  assert.equal((await srv.api('GET', `/api/sessions/${sessionId}/history`, { token: outsider.token })).status, 403);
  assert.equal((await srv.api('GET', `/api/sessions/${sessionId}/history`)).status, 401);

  // finished rooms are released: both can start something new
  assert.equal((await a.client.emit('leave-room', {})).ok, true);
  assert.equal((await b.client.emit('create-room', {})).ok, true);
});

test('the limit chosen for the room decides who is out (101 vs the default 201)', async () => {
  const playWith = async (points) => {
    const a = await srv.player(nick('Lim A'));
    const b = await srv.player(nick('Lim B'));
    const { roomCode } = (await a.client.emit('create-room', points ? { points } : {})).data;
    await b.client.emit('join-room', { roomCode });
    await a.client.emit('start-game', {});
    await a.client.waitFor('game-state');
    await b.client.waitFor('game-state');
    const live = srv.container.gameSessions.live.get(roomCode);
    const dropper = current([a, b]);
    live.state.players[dropper.userId].score = 85; // a first drop adds 20: 105
    await dropper.client.emit('player-drop', { requestId: rid() });
    await a.client.waitFor('round-completed');
    return { live, dropper };
  };
  const strict = await playWith(101);
  assert.equal(strict.live.state.players[strict.dropper.userId].status, 'eliminated', '105 is over 101');
  assert.equal(strict.live.state.stage, 'completed');
  const normal = await playWith(null);
  assert.equal(normal.live.state.players[normal.dropper.userId].status, 'active', '105 is below 201');
  assert.equal(normal.live.state.stage, 'between-rounds');
});

test('the chosen limit survives a server restart', async () => {
  const first = await startTestServer();
  try {
    const a = await first.player(nick('Lim R1'));
    const b = await first.player(nick('Lim R2'));
    const { roomCode } = (await a.client.emit('create-room', { points: 301 })).data;
    await b.client.emit('join-room', { roomCode });
    await a.client.emit('start-game', {});
    await a.client.waitFor('game-state');
    await first.stop({ keepDb: true });
    const second = await startTestServer({ db: first.db });
    try {
      const ca = await second.connect(a.token);
      const resumed = await ca.emit('resume', { roomCode });
      assert.equal(resumed.data.room.eliminationPoints, 301);
      assert.equal(resumed.data.view.config.eliminationThreshold, 301);
    } finally {
      await second.stop();
    }
  } catch (err) {
    await first.stop().catch(() => {});
    throw err;
  }
});

test('eliminated players are spectators: no cards, cannot act, cannot be dealt into the next round', async () => {
  const { players, roomCode, live } = await startRoom(3);
  const [a, b, c] = players;
  rig(live(), { [a.userId]: VALID_HAND, [b.userId]: JUNK_1, [c.userId]: JUNK_2 }, { current: a.userId });
  live().state.players[b.userId].score = 190;
  await a.client.emit('declare-game', { requestId: rid(), groups: groupIds(VALID_GROUPS) });
  await b.client.waitFor('player-eliminated');
  assert.equal(a.client.all('game-completed').length, 0, 'two players remain, the game goes on');

  // the next round starts once the remaining players are ready (the eliminated one is not waited for)
  assert.equal((await a.client.emit('next-round-ready', {})).data.started, false);
  assert.equal((await c.client.emit('next-round-ready', {})).data.started, true);
  await b.client.waitFor('dealer-selected', { where: (d) => d.roundNo === 2 });
  await a.client.waitFor('game-state', { where: (s) => s.roundNo === 2 });
  await b.client.waitFor('game-state', { where: (s) => s.roundNo === 2 });

  const view = b.client.lastState();
  assert.equal(view.me, null, 'no cards for an eliminated player');
  assert.equal(view.players.find((p) => p.playerId === b.userId).status, 'eliminated');
  assert.equal(view.players.filter((p) => p.handCount === 13).length, 2);
  assert.equal(errCode(await b.client.emit('draw-card', { requestId: rid(), source: 'draw' })), 'PLAYER_ELIMINATED');
  assert.equal(errCode(await b.client.emit('player-drop', { requestId: rid() })), 'PLAYER_ELIMINATED');

  // rejoining as the same member just reconnects the spectator; strangers cannot get in
  const rejoin = await b.client.emit('join-room', { roomCode });
  assert.equal(rejoin.data.rejoined, true);
  const stranger = await srv.player(nick('Stranger'));
  assert.equal(errCode(await stranger.client.emit('join-room', { roomCode })), 'ROOM_STARTED');

  // the dealer rotated to a player who is still in the game
  const dealer = view.round.dealerId;
  assert.notEqual(dealer, b.userId);
});

test('disconnect and reconnect: others are told, the seat and the hand are kept', async () => {
  const { players, roomCode } = await startRoom(2);
  const [a, b] = players;
  const handBefore = b.client.lastState().me.hand.map((c) => c.id);

  const mark = a.client.mark();
  b.client.socket.close();
  const gone = await a.client.waitFor('player-disconnected', { after: mark });
  assert.equal(gone.payload.playerId, b.userId);
  const room = await a.client.waitFor('room-updated', { after: mark, where: (r) => r.players.some((p) => !p.isConnected) });
  assert.equal(room.payload.players.find((p) => p.playerId === b.userId).isConnected, false);

  const mark2 = a.client.mark();
  const again = await b.reconnect();
  const back = await a.client.waitFor('player-reconnected', { after: mark2 });
  assert.equal(back.payload.playerId, b.userId);

  const resumed = await again.emit('resume', { roomCode });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.data.view.me.hand.map((c) => c.id), handBefore);
  assert.equal(resumed.data.room.status, 'in_progress');
  assert.equal(resumed.data.view.round.currentPlayerId, a.client.lastState().round.currentPlayerId);

  // the reconnected socket receives live events again and can act on its turn
  b.client = again;
  const actor = resumed.data.view.round.currentPlayerId === a.userId ? a : b;
  await playTurn([a, b], actor);
  const stored = (await rows('SELECT is_connected FROM room_players rp JOIN game_rooms r ON r.id = rp.room_id WHERE r.room_code = $1 AND rp.user_id = $2', [roomCode, b.userId]))[0];
  assert.equal(stored.is_connected, true);
});

test('simultaneous actions are applied one at a time; the loser gets a clear error', async () => {
  const { players } = await startRoom(3);
  const first = current(players);
  const [second, third] = others(players, first);

  // three players press "draw" in the same instant
  const results = await Promise.all([first, second, third].map((p) => p.client.emit('draw-card', { requestId: rid(), source: 'draw' })));
  assert.deepEqual(results.map((r) => r.ok), [true, false, false]);
  assert.deepEqual(results.slice(1).map(errCode), ['NOT_YOUR_TURN', 'NOT_YOUR_TURN']);

  // the same player sends two different draws at once, then one request id twice
  const hand = first.client.lastState().me.hand.map((c) => c.id);
  const dup = await Promise.all([
    first.client.emit('discard-card', { requestId: rid(), cardId: hand[0], endTurn: false }),
    first.client.emit('discard-card', { requestId: rid(), cardId: hand[1], endTurn: false }),
  ]);
  assert.deepEqual(dup.map((r) => r.ok).sort(), [false, true]);
  assert.equal(errCode(dup.find((r) => !r.ok)), 'ALREADY_DISCARDED');
  const ended = await first.client.emit('end-turn', { requestId: rid() });
  await settle(players, ended.data.view.version);

  const same = rid();
  const target = current(players);
  const pair = await Promise.all([
    target.client.emit('draw-card', { requestId: same, source: 'draw' }),
    target.client.emit('draw-card', { requestId: same, source: 'draw' }),
  ]);
  assert.deepEqual(pair.map((r) => r.ok), [true, true]);
  assert.deepEqual(pair.map((r) => r.data.duplicate).sort(), [false, true]);
  assert.equal(target.client.lastState().me.hand.length, 14, 'the card was drawn exactly once');
});

test('a repeated request id never re-applies an action (idempotency)', async () => {
  const { players } = await startRoom(2);
  const first = current(players);
  const id = rid();
  const one = await first.client.emit('draw-card', { requestId: id, source: 'draw' });
  const two = await first.client.emit('draw-card', { requestId: id, source: 'draw' });
  assert.equal(one.data.duplicate, false);
  assert.equal(two.data.duplicate, true);
  assert.equal(two.data.view.me.hand.length, 14);
  const stored = await rows('SELECT count(*)::int AS n FROM game_actions WHERE idempotency_key = $1', [id]);
  assert.equal(stored[0].n, 1);
});

test('one card to win over sockets: accepted only when eligible, visible to all without cards', async () => {
  const { players, live } = await startRoom(2);
  const [a, b] = players;
  rig(live(), { [a.userId]: '7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 9C 9S KH', [b.userId]: JUNK_1 }, { current: a.userId });
  assert.equal(errCode(await b.client.emit('one-card-to-win', { requestId: rid(), active: true })), 'ONE_CARD_NOT_ELIGIBLE');
  const markB = b.client.mark(); // the K was possibly dealt to b before this test rigged the hands, so only look at what follows
  const ok = await a.client.emit('one-card-to-win', { requestId: rid(), active: true });
  assert.equal(ok.ok, true);
  const seen = await b.client.waitFor('one-card-to-win');
  assert.deepEqual(seen.payload, { playerId: a.userId, active: true });
  assert.ok(!JSON.stringify(b.client.events.slice(markB)).includes('D1-H-K'));
  const off = await a.client.emit('one-card-to-win', { requestId: rid(), active: false });
  assert.equal(off.ok, true);
  assert.equal((await b.client.waitFor('one-card-to-win', { where: (e) => e.active === false })).payload.active, false);
});

test('the game survives a server restart: state is restored from PostgreSQL and play continues', async () => {
  const first = await startTestServer();
  try {
    const a = await first.player(nick('Persist A'));
    const b = await first.player(nick('Persist B'));
    const { roomCode } = (await a.client.emit('create-room', {})).data;
    await b.client.emit('join-room', { roomCode });
    await a.client.emit('start-game', {});
    await a.client.waitFor('game-state');
    await b.client.waitFor('game-state');
    await playTurn([a, b]);
    const live = first.container.gameSessions.live.get(roomCode);
    const version = live.state.version;
    const hands = Object.fromEntries([a, b].map((p) => [p.userId, p.client.lastState().me.hand.map((c) => c.id)]));
    const currentId = live.state.round.currentPlayerId;
    await first.stop({ keepDb: true });

    // a brand new server process on the same database
    const second = await startTestServer({ db: first.db });
    try {
      const preview = await second.api('GET', `/api/rooms/${roomCode}`);
      assert.equal(preview.json.data.status, 'in_progress');
      const ca = await second.connect(a.token);
      const cb = await second.connect(b.token);
      const ra = await ca.emit('resume', { roomCode });
      const rb = await cb.emit('resume', { roomCode });
      assert.equal(ra.data.view.version, version);
      assert.deepEqual(ra.data.view.me.hand.map((c) => c.id), hands[a.userId]);
      assert.deepEqual(rb.data.view.me.hand.map((c) => c.id), hands[b.userId]);
      assert.equal(ra.data.view.round.currentPlayerId, currentId);

      const actor = currentId === a.userId ? ca : cb;
      const draw = await actor.emit('draw-card', { requestId: rid(), source: 'draw' });
      assert.equal(draw.ok, true);
      assert.equal(draw.data.view.version, version + 1);
    } finally {
      await second.stop();
    }
  } finally {
    // `first.db` was closed by `second.stop()`
  }
});

test('idle rooms are abandoned and closed in the database; busy rooms are left alone', async () => {
  const idle = await srv.player(nick('Idle'));
  const busy = await srv.player(nick('Busy'));
  const { roomCode: idleCode } = (await idle.client.emit('create-room', {})).data;
  const { roomCode: busyCode } = (await busy.client.emit('create-room', {})).data;
  idle.client.socket.close();
  for (let i = 0; i < 50 && srv.container.presence.isConnected(idle.userId); i += 1) await new Promise((r) => setTimeout(r, 20));

  await srv.container.rooms.sweepIdle(Date.now() + 31 * 60 * 1000);
  assert.equal((await srv.api('GET', `/api/rooms/${idleCode}`)).status, 404);
  assert.equal((await srv.api('GET', `/api/rooms/${busyCode}`)).status, 200);
  assert.equal((await rows('SELECT status FROM game_rooms WHERE room_code = $1', [idleCode]))[0].status, 'abandoned');
  assert.equal((await rows('SELECT status FROM game_rooms WHERE room_code = $1', [busyCode]))[0].status, 'waiting');
});

test('a flood of socket events is rate limited', async () => {
  const p = await srv.player(nick('Flood'));
  const results = await Promise.all(Array.from({ length: 80 }, () => p.client.emit('end-turn', { requestId: rid() })));
  const codes = results.map(errCode);
  assert.ok(codes.includes('RATE_LIMITED'), 'burst must be cut off');
  assert.ok(codes.includes('NOT_IN_ROOM'), 'the first events still get a normal answer');

  let t = 0;
  const bucket = createBucket({ capacity: 3, refillPerSecond: 1, now: () => t });
  assert.deepEqual([bucket(), bucket(), bucket(), bucket()], [true, true, true, false]);
  t += 1000;
  assert.equal(bucket(), true);
});
