'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextTimer } = require('../../src/games/set/game-engine');
const { viewFor } = require('../../src/games/set/view');
const { scenario, act, groupIds } = require('../helpers/cards');

const VALID_HAND = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C';
const VALID_GROUPS = ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C'];
// p2 scores 16 and p3 scores 44 at best (see engine-flow.test.js)
const P2 = '5H 5D 5C 5S 6H 6D 6C 2H 2D 2C 3H 3D KH';
const P3 = '4H 4D 4C 4S QH QD QC JH JD 3C 3S 9H/2 9D/2';

const names = (r) => r.events.map((e) => e.name);
const rejects = (fn, code) => assert.throws(fn, (err) => err.code === code, `expected ${code}`);

function showGame(seconds = 30) {
  const state = scenario({ n: 3, config: { showWindowSeconds: seconds }, hands: { p1: VALID_HAND, p2: P2, p3: P3 }, openJoker: 'A' });
  state.round.currentPlayerId = 'p1';
  return act(state, { type: 'declare', playerId: 'p1', groups: groupIds(VALID_GROUPS) });
}

// ---------------------------------------------------------------------------
// after a valid declaration the others arrange and submit
// ---------------------------------------------------------------------------

test('a valid declaration opens the show: the round waits for the others, the winning hand is public', () => {
  const { state, events } = showGame();
  assert.equal(state.stage, 'in-round');
  assert.equal(state.round.phase, 'showing');
  assert.equal(state.round.result, null, 'not scored yet');
  assert.equal(state.round.currentPlayerId, null, 'nobody draws or discards now');
  const started = events.find((e) => e.name === 'show-started');
  assert.equal(started.to, 'all');
  assert.equal(started.payload.declarerId, 'p1');
  assert.deepEqual(started.payload.waitingFor.sort(), ['p2', 'p3']);
  assert.equal(started.payload.reveal.cards.length, 13);
  assert.ok(!names({ events }).includes('round-completed'));

  const v2 = viewFor(state, 'p2');
  assert.equal(v2.round.phase, 'showing');
  assert.equal(v2.round.show.declarerId, 'p1');
  assert.equal(v2.round.show.cards.length, 13, 'everyone sees the shown hand');
  assert.equal(v2.me.canSubmitShow, true);
  assert.equal(v2.me.canDeclare, false);
  assert.equal(viewFor(state, 'p1').me.canSubmitShow, false, 'the declarer has nothing to submit');

  assert.deepEqual(nextTimer(state), { kind: 'show', playerId: null, seconds: 30, roundNo: 1, turnNo: state.round.turnNo });
});

test('during the show nobody can draw, drop or declare, but they can arrange their cards', () => {
  const { state } = showGame();
  rejects(() => act(state, { type: 'draw', playerId: 'p2', source: 'draw' }), 'NOT_YOUR_TURN');
  rejects(() => act(state, { type: 'drop', playerId: 'p3' }), 'NOT_YOUR_TURN');
  rejects(() => act(state, { type: 'one-card-to-win', playerId: 'p2', active: true }), 'SHOW_IN_PROGRESS');
  const groups = [state.round.hands.p2.slice(0, 4).map((c) => c.id), ...state.round.hands.p2.slice(4).map((c) => [c.id])];
  const r = act(state, { type: 'arrange', playerId: 'p2', groups });
  assert.deepEqual(r.state.round.groups.p2[0], groups[0]);
});

test('when everyone has submitted, the round is scored at once: points are still the best possible', () => {
  const { state } = showGame();
  // p2 submits a poor layout (every card on its own): it must not cost anything
  const loose = state.round.hands.p2.map((c) => [c.id]);
  const r2 = act(state, { type: 'submit-show', playerId: 'p2', groups: loose });
  assert.equal(r2.state.round.phase, 'showing', 'still waiting for p3');
  assert.deepEqual(r2.state.round.show.pending, ['p3']);
  assert.ok(names(r2).includes('show-submitted'));
  rejects(() => act(r2.state, { type: 'submit-show', playerId: 'p2' }), 'ALREADY_SUBMITTED');
  rejects(() => act(r2.state, { type: 'submit-show', playerId: 'p1' }), 'NOT_IN_ROUND');

  const r3 = act(r2.state, { type: 'submit-show', playerId: 'p3' });
  assert.equal(r3.state.stage, 'between-rounds');
  assert.equal(r3.state.round.result.winnerId, 'p1');
  assert.equal(r3.state.round.result.endReason, 'valid_declaration');
  assert.equal(r3.state.players.p2.score, 16);
  assert.equal(r3.state.players.p3.score, 44);
  const done = r3.events.find((e) => e.name === 'round-completed');
  assert.ok(done.payload.reveals.p1 && done.payload.reveals.p2 && done.payload.reveals.p3);
});

test('when the show time runs out, the round is scored with whoever has not submitted', () => {
  const { state } = showGame();
  const r2 = act(state, { type: 'submit-show', playerId: 'p2' });
  const r = act(r2.state, { type: 'show-timeout' });
  assert.equal(r.state.stage, 'between-rounds');
  assert.equal(r.state.players.p2.score, 16);
  assert.equal(r.state.players.p3.score, 44);
  rejects(() => act(r.state, { type: 'show-timeout' }), 'ROUND_NOT_ACTIVE');
});

test('submitting when nobody has shown is refused; with no show window the round is scored at once', () => {
  const state = scenario({ n: 3, hands: { p1: VALID_HAND, p2: P2, p3: P3 }, openJoker: 'A' });
  state.round.currentPlayerId = 'p1';
  rejects(() => act(state, { type: 'submit-show', playerId: 'p2' }), 'NOT_SHOWING');
  const r = act(state, { type: 'declare', playerId: 'p1', groups: groupIds(VALID_GROUPS) });
  assert.equal(r.state.stage, 'between-rounds');
  assert.ok(!names(r).includes('show-started'));
});

// ---------------------------------------------------------------------------
// Exit: leaving the game for good, no penalty
// ---------------------------------------------------------------------------

test('leaving mid-round (not my turn): out of the game, no points, the round carries on', () => {
  const state = scenario({ n: 3, current: 'p1' });
  const r = act(state, { type: 'leave', playerId: 'p3' });
  assert.equal(r.state.players.p3.status, 'left');
  assert.equal(r.state.round.playerStatus.p3, 'left');
  assert.equal(r.state.round.currentPlayerId, 'p1', 'the turn does not move');
  assert.equal(r.state.stage, 'in-round');
  assert.ok(names(r).includes('player-left-game'));
  rejects(() => act(r.state, { type: 'draw', playerId: 'p3', source: 'draw' }), 'PLAYER_LEFT');
  rejects(() => act(r.state, { type: 'leave', playerId: 'p3' }), 'PLAYER_LEFT');

  // p1 and p2 drop in turn: p2 wins; the one who left is recorded with 0 points
  const d1 = act(r.state, { type: 'drop', playerId: 'p1' });
  assert.equal(d1.state.stage, 'between-rounds');
  const row = d1.state.round.result.results.find((x) => x.playerId === 'p3');
  assert.deepEqual([row.penalty, row.reason, row.roundStatus], [0, 'left', 'left']);
  assert.equal(d1.state.players.p3.score, 0);
});

test('leaving on my own turn passes the turn to the next player', () => {
  const state = scenario({ n: 3, current: 'p2' });
  const r = act(state, { type: 'leave', playerId: 'p2' });
  assert.equal(r.state.round.currentPlayerId, 'p3');
  assert.equal(r.state.round.phase, 'awaiting-draw');
  assert.ok(names(r).includes('player-turn'));
});

test('a later round is dealt only to the players still in the game', () => {
  const state = scenario({ n: 3, current: 'p1' });
  let s = act(state, { type: 'leave', playerId: 'p3' }).state;
  s = act(s, { type: 'drop', playerId: 'p1' }).state; // p2 is last standing
  s = act(s, { type: 'start-next-round' }).state;
  assert.deepEqual(s.round.order.slice().sort(), ['p1', 'p2']);
  assert.equal(s.round.hands.p3, undefined);
});

test('two players: when one leaves during a round, the other wins the game', () => {
  const state = scenario({ n: 2, current: 'p1' });
  state.players.p2.score = 50;
  const r = act(state, { type: 'leave', playerId: 'p2' });
  assert.equal(r.state.stage, 'completed');
  assert.equal(r.state.winnerId, 'p1');
  assert.equal(r.state.players.p2.score, 50, 'no penalty for leaving');
  const done = r.events.find((e) => e.name === 'game-completed');
  assert.equal(done.payload.winnerId, 'p1');
});

test('two players: leaving between rounds ends the game too', () => {
  const state = scenario({ n: 2, current: 'p1' });
  const between = act(state, { type: 'drop', playerId: 'p1' }).state;
  assert.equal(between.stage, 'between-rounds');
  const r = act(between, { type: 'leave', playerId: 'p1' });
  assert.equal(r.state.stage, 'completed');
  assert.equal(r.state.winnerId, 'p2');
});

test('leaving during the show: the last player still to submit leaving scores the round', () => {
  const { state } = showGame();
  const r2 = act(state, { type: 'submit-show', playerId: 'p2' });
  const r = act(r2.state, { type: 'leave', playerId: 'p3' });
  assert.equal(r.state.stage, 'between-rounds');
  const row = r.state.round.result.results.find((x) => x.playerId === 'p3');
  assert.deepEqual([row.penalty, row.reason], [0, 'left']);
  assert.equal(r.state.players.p2.score, 16);
});

test('the declarer leaving during the show still wins that round, then is out of the game', () => {
  const { state } = showGame();
  const r = act(state, { type: 'leave', playerId: 'p1' });
  assert.equal(r.state.round.result.winnerId, 'p1');
  assert.equal(r.state.players.p1.status, 'left');
  assert.equal(r.state.players.p2.score, 16);
  assert.equal(r.state.stage, 'between-rounds', 'p2 and p3 play on');
});

test('an eliminated player cannot "leave" through the engine (the platform just stops showing them the game)', () => {
  const state = scenario({ n: 3, current: 'p1' });
  state.players.p3.status = 'eliminated';
  rejects(() => act(state, { type: 'leave', playerId: 'p3' }), 'PLAYER_ELIMINATED');
});
