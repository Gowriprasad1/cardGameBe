'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../helpers/server');

let counter = 0;
const nick = (l) => `${l} ${(counter += 1)}`;

async function startRoom(srv, count = 2) {
  const players = [];
  for (let i = 0; i < count; i += 1) players.push(await srv.player(nick(`Timer${i}`)));
  const { roomCode } = (await players[0].client.emit('create-room', {})).data;
  for (const p of players.slice(1)) await p.client.emit('join-room', { roomCode });
  await players[0].client.emit('start-game', {});
  for (const p of players) await p.client.waitFor('game-state');
  return { players, roomCode, live: () => srv.container.gameSessions.live.get(roomCode) };
}

test('turn timer: a player who runs out of time is auto-played, then auto-dropped after repeated timeouts', async () => {
  const srv = await startTestServer({ env: { TURN_TIMER_SECONDS: '1' } });
  try {
    const { players, live } = await startRoom(srv);
    const [a] = players;
    const first = live().state.round.currentPlayerId;
    const turn = await a.client.waitFor('player-turn');
    assert.equal(turn.payload.seconds, 1);
    assert.ok(turn.payload.deadlineAt > Date.now() - 100 && turn.payload.deadlineAt < Date.now() + 2000);
    // every view carries the same deadline, so a client that reconnects can show the countdown too
    const state = a.client.lastState();
    assert.ok(state.turnDeadlineAt > Date.now() - 200 && state.turnDeadlineAt < Date.now() + 2000);
    const resumed = await a.client.emit('resume', {});
    assert.ok(resumed.data.view.turnDeadlineAt > Date.now() - 200);

    // nobody acts: the server plays the turn itself and passes it on
    const next = await a.client.waitFor('player-turn', { where: (t) => t.turnNo === 2, timeout: 4000 });
    assert.notEqual(next.payload.playerId, first);
    assert.equal(live().state.round.timeouts[first], 1);
    assert.equal(live().state.round.hands[first].length, 13, 'auto-play keeps 13 cards');

    // repeated timeouts drop the player (counter pushed to the limit to keep the test fast)
    const stalled = live().state.round.currentPlayerId;
    live().state.round.timeouts[stalled] = 2;
    const drop = await a.client.waitFor('player-drop', { timeout: 4000 });
    assert.equal(drop.payload.playerId, stalled);
    assert.equal(drop.payload.auto, true);
    assert.equal(drop.payload.type, 'first', 'the stalled player had not completed a turn yet, so it is the 20 point drop');
    assert.equal(drop.payload.penalty, 20);
  } finally {
    await srv.stop();
  }
});

test('with the timer off, a disconnected player cannot freeze the table: their turn is auto-played after the grace period', async () => {
  const srv = await startTestServer({ env: { TURN_TIMER_SECONDS: '0', RECONNECT_GRACE_SECONDS: '1' } });
  try {
    const { players, live } = await startRoom(srv);
    const turnUserId = live().state.round.currentPlayerId;
    const stuck = players.find((p) => p.userId === turnUserId);
    const other = players.find((p) => p !== stuck);
    assert.equal(live().timerPlan, null, 'no timer while the player is connected and the timer is off');

    const mark = other.client.mark();
    stuck.client.socket.close();
    const moved = await other.client.waitFor('player-turn', { after: mark, where: (t) => t.turnNo === 2, timeout: 5000 });
    assert.equal(moved.payload.playerId, other.userId);
    assert.equal(live().state.round.timeouts[stuck.userId], 1);
  } finally {
    await srv.stop();
  }
});

test('the next round starts by itself after the break, and the break can be skipped when everyone is ready', async () => {
  const srv = await startTestServer({ env: { ROUND_BREAK_SECONDS: '1' } });
  try {
    const { players } = await startRoom(srv);
    const [a, b] = players;
    const dropper = players.find((p) => p.userId === a.client.lastState().round.currentPlayerId);
    await dropper.client.emit('player-drop', { requestId: 'drop-request-1' });
    await a.client.waitFor('round-completed');
    const round2 = await a.client.waitFor('dealer-selected', { where: (d) => d.roundNo === 2, timeout: 4000 });
    assert.ok(players.some((p) => p.userId === round2.payload.dealerId));
    assert.equal((await b.client.waitFor('game-state', { where: (s) => s.roundNo === 2 })).payload.me.hand.length, 13);
    // scores from round 1 carry over and every card was redealt
    assert.equal(a.client.lastState().history.length, 1);
  } finally {
    await srv.stop();
  }
});

test('next-round-ready from everyone starts the round immediately', async () => {
  const srv = await startTestServer({ env: { ROUND_BREAK_SECONDS: '600' } });
  try {
    const { players } = await startRoom(srv);
    const [a, b] = players;
    const dropper = players.find((p) => p.userId === a.client.lastState().round.currentPlayerId);
    await dropper.client.emit('player-drop', { requestId: 'drop-request-2' });
    await a.client.waitFor('round-completed');
    assert.equal((await a.client.emit('next-round-ready', {})).data.started, false);
    assert.equal((await b.client.emit('next-round-ready', {})).data.started, true);
    await a.client.waitFor('dealer-selected', { where: (d) => d.roundNo === 2 });
  } finally {
    await srv.stop();
  }
});
