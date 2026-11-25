'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, rid } = require('../helpers/server');
const { attachBot } = require('../helpers/socket-bot');
const { decideRummy } = require('../helpers/rummy-bot');
const { rigHands, groupIds, setDiscardTop, setOpenJoker } = require('../helpers/cards');

const FAST = { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000' };
const WIN = '4H 5H 6H 7S 8S JK1 9D 9C 9S 2D 2C 2S 2H';
const WIN_GROUPS = ['4H 5H 6H', '7S 8S JK1', '9D 9C 9S', '2D 2C 2S 2H'];
const NO_PURE = '3C 5D 7H KS QD 3D 4C 6S 8H 10D JC AS KH'; // counts in full (capped at 80)

async function startRoom(srv, count, label, points) {
  const players = [];
  for (let i = 0; i < count; i += 1) players.push(await srv.player(`${label}${i}`));
  const { roomCode, room } = (await players[0].client.emit('create-room', { gameType: 'RUMMY', ...(points ? { points } : {}) })).data;
  for (const p of players.slice(1)) assert.equal((await p.client.emit('join-room', { roomCode })).ok, true);
  assert.equal((await players[0].client.emit('start-game', {})).ok, true);
  for (const p of players) await p.client.waitFor('game-state');
  return { players, roomCode, room, live: () => srv.container.gameSessions.live.get(roomCode) };
}

for (const n of [2, 3, 5]) {
  test(`a ${n}-player Rummy room starts: 13 private cards each, the game type is saved`, async () => {
    const srv = await startTestServer({ env: FAST });
    try {
      const { players, roomCode, room } = await startRoom(srv, n, `Rum${n}`);
      assert.equal(room.gameType, 'RUMMY');
      for (const p of players) {
        const view = p.client.lastState();
        assert.equal(view.game, 'RUMMY');
        assert.equal(view.me.hand.length, 13);
        assert.equal(view.deckCount, n === 2 ? 1 : 2);
        assert.equal(view.features.oneCardToWin, false);
      }
      const row = (await srv.db.query(
        'SELECT g.code FROM game_rooms r JOIN game_types g ON g.id = r.game_type_id WHERE r.room_code = $1', [roomCode])).rows[0];
      assert.equal(row.code, 'RUMMY');
      // nobody ever sees another player's cards
      const hands = players.map((p) => p.client.lastState().me.hand.map((c) => c.id));
      players.forEach((viewer, i) => {
        const log = JSON.stringify(viewer.client.events);
        hands.forEach((ids, j) => { if (i !== j) for (const id of ids) assert.ok(!log.includes(`"${id}"`), `leak ${id}`); });
      });
    } finally {
      await srv.stop();
    }
  });
}

test('a valid show over sockets: the winner is free, the other player is counted and everything is saved', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const { players, roomCode, live } = await startRoom(srv, 2, 'RumShow');
    const [a, b] = players;
    // the hands use all four 2s, so pick a wild-joker number that no rigged hand needs
    setOpenJoker(live().state, '10');
    rigHands(live().state, { [a.userId]: WIN, [b.userId]: NO_PURE });
    live().state.round.currentPlayerId = a.userId;

    const res = await a.client.emit('declare-game', { requestId: rid(), groups: groupIds(WIN_GROUPS) });
    assert.equal(res.ok, true, JSON.stringify(res));
    const done = await b.client.waitFor('round-completed');
    assert.equal(done.payload.winnerId, a.userId);
    const loser = done.payload.results.find((r) => r.playerId === b.userId);
    // no pure sequence: every card counts. The face-up wild-joker number is random, and its cards count 0.
    assert.equal(loser.reason, 'no_pure_sequence');
    assert.ok(loser.penalty > 0 && loser.penalty <= 80);
    // the face-up wild-joker number is random: a group made of wild-joker cards can read as a sequence
    const kinds = done.payload.reveals[a.userId].groups.map((g) => g.kind);
    assert.equal(kinds.length, 4);
    assert.equal(kinds[0], 'pure');
    assert.ok(kinds.every((k) => ['pure', 'seq', 'set'].includes(k)));

    // the database accepts the Rummy-only score reason (migration 002)
    const stored = (await srv.db.query(
      `SELECT ps.penalty, ps.reason FROM player_scores ps JOIN game_rounds gr ON gr.id = ps.round_id
         JOIN game_sessions s ON s.id = gr.session_id JOIN game_rooms r ON r.id = s.room_id
        WHERE r.room_code = $1 ORDER BY ps.penalty`, [roomCode])).rows;
    assert.deepEqual(stored, [{ penalty: 0, reason: 'winner' }, { penalty: loser.penalty, reason: 'no_pure_sequence' }]);
  } finally {
    await srv.stop();
  }
});

test('a wrong show over sockets costs 80 and tells only the declarer why', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const { players, live } = await startRoom(srv, 3, 'RumBad');
    const [a, b] = players;
    setOpenJoker(live().state, '10');
    rigHands(live().state, { [a.userId]: '4H 5H JK1 7S 8S JK2 9D 9C 9S 2D 2C 2S 2H' });
    live().state.round.currentPlayerId = a.userId;
    const markB = b.client.mark();
    const res = await a.client.emit('declare-game', {
      requestId: rid(), groups: groupIds(['4H 5H JK1', '7S 8S JK2', '9D 9C 9S', '2D 2C 2S 2H']),
    });
    assert.equal(res.ok, true);
    const result = await b.client.waitFor('declaration-result', { after: markB });
    assert.deepEqual([result.payload.valid, result.payload.penalty], [false, 80]);
    assert.equal((await a.client.waitFor('declaration-errors')).payload.errors[0].code, 'NO_PURE_SEQUENCE');
    assert.equal(b.client.all('declaration-errors').length, 0);
  } finally {
    await srv.stop();
  }
});

test('1 CARD TO WIN is refused in Rummy, and a printed joker on the open pile cannot be taken', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const { players, live } = await startRoom(srv, 2, 'RumRules');
    const [a, b] = players;
    const cur = live().state.round.currentPlayerId;
    const actor = cur === a.userId ? a : b;
    const refused = await actor.client.emit('one-card-to-win', { requestId: rid(), active: true });
    assert.equal(refused.error.code, 'ONE_CARD_NOT_ELIGIBLE');

    setDiscardTop(live().state, 'JK1'); // a printed joker lands on top of the open pile
    const take = await actor.client.emit('draw-card', { requestId: rid(), source: 'discard' });
    assert.equal(take.error.code, 'JOKER_NOT_PICKABLE');
    assert.equal((await actor.client.emit('draw-card', { requestId: rid(), source: 'draw' })).ok, true);
  } finally {
    await srv.stop();
  }
});

for (const [n, points] of [[2, 101], [4, 201]]) {
  test(`${n} bots play a whole Rummy game (limit ${points}) to a winner; results are saved and the working data is cleaned`, async () => {
    const srv = await startTestServer({ env: FAST });
    try {
      const { players, roomCode } = await startRoom(srv, n, `RumBot${n}`, points);
      players.forEach((p, i) => attachBot(p.client, { maxTurns: 4, quitsFirst: i === 0 }, decideRummy));
      // the bots attach after the first state, so nudge them with the current one
      for (const p of players) p.client.socket.emit('resume', {}, () => {});
      const state0 = players.map((p) => p.client.lastState());
      players.forEach((p, i) => p.client.socket.listeners('game-state').forEach((fn) => fn(state0[i])));
      const done = await Promise.all(players.map((p) => p.client.waitFor('game-completed', { timeout: 120000 })));
      for (const p of players) assert.equal(p.client.botError, undefined, p.client.botError && p.client.botError.message);
      const final = done[0].payload;

      assert.equal(final.finalScoreboard.filter((s) => s.isWinner).length, 1);
      for (const row of final.finalScoreboard) {
        if (row.status === 'eliminated') assert.ok(row.cumulativeScore >= points);
        else assert.ok(row.cumulativeScore < points);
      }
      const history = (await srv.db.query(
        'SELECT gh.total_rounds, gh.winner_user_id FROM game_history gh JOIN game_rooms r ON r.id = gh.room_id WHERE r.room_code = $1', [roomCode])).rows;
      assert.deepEqual(history, [{ total_rounds: final.totalRounds, winner_user_id: final.winnerId }]);
      const left = (await srv.db.query(
        `SELECT count(*)::int AS n FROM card_decks cd JOIN game_rounds gr ON gr.id = cd.round_id
           JOIN game_sessions s ON s.id = gr.session_id JOIN game_rooms r ON r.id = s.room_id WHERE r.room_code = $1`, [roomCode])).rows[0];
      assert.equal(left.n, 0, 'cards are deleted when the game ends');
    } finally {
      await srv.stop();
    }
  });
}
