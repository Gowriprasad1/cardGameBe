'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGame, applyAction, nextTimer } = require('../../src/games/set/game-engine');
const { viewFor } = require('../../src/games/set/view');
const {
  scenario, act, playTurn, groupIds, seededRng, playersOf, setDrawTop,
} = require('../helpers/cards');

const VALID_HAND = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C';
const VALID_GROUPS = ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C'];
// A hand with no groups and no overlap with VALID_HAND (works in one-deck games).
const JUNK_HAND = '2H 3H 4H 5H 6H JH QH KS 2D 3D 4D 5D 6D';

const eventNames = (r) => r.events.map((e) => e.name);
const rejects = (fn, code) => assert.throws(fn, (err) => err.code === code, `expected ${code}`);

/** An arbitrary card from the player's hand that is not part of `keep`. */
const anyCard = (state, id) => state.round.hands[id][0].id;

// ---------------------------------------------------------------------------
// game start
// ---------------------------------------------------------------------------

for (const n of [2, 3, 4, 5]) {
  test(`${n}-player game starts: backend picks dealer, deals 13 each, sets first player`, () => {
    const { state, events } = createGame({ players: playersOf(n), rng: seededRng(n) });
    assert.equal(state.deckCount, n === 2 ? 1 : 2);
    const ids_ = state.seatOrder;
    assert.ok(ids_.includes(state.round.dealerId));
    for (const id of ids_) assert.equal(state.round.hands[id].length, 13);
    const dealerIdx = ids_.indexOf(state.round.dealerId);
    assert.equal(state.round.currentPlayerId, ids_[(dealerIdx + 1) % n], 'player after the dealer starts');
    assert.equal(state.round.phase, 'awaiting-draw');
    const names = events.map((e) => e.name);
    for (const expected of ['game-started', 'dealer-selected', 'cards-distributed', 'hand-updated', 'player-turn']) {
      assert.ok(names.includes(expected), `missing event ${expected}`);
    }
    assert.equal(events.filter((e) => e.name === 'hand-updated').length, n);
  });
}

test('SET needs 2 to 5 players and no duplicates', () => {
  assert.throws(() => createGame({ players: playersOf(1) }), { code: 'INVALID_PLAYER_COUNT' });
  assert.throws(() => createGame({ players: playersOf(6) }), { code: 'INVALID_PLAYER_COUNT' });
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'a' }] }), { code: 'DUPLICATE_PLAYER' });
});

// ---------------------------------------------------------------------------
// 23. Turn validation
// ---------------------------------------------------------------------------

test('only the active player can act', () => {
  const state = scenario({ n: 3 });
  const active = state.round.currentPlayerId;
  const other = state.seatOrder.find((id) => id !== active);
  rejects(() => act(state, { type: 'draw', playerId: other, source: 'draw' }), 'NOT_YOUR_TURN');
  rejects(() => act(state, { type: 'drop', playerId: other }), 'NOT_YOUR_TURN');
  rejects(() => act(state, { type: 'declare', playerId: other, groups: [] }), 'NOT_YOUR_TURN');
  rejects(() => act(state, { type: 'discard', playerId: other, cardId: 'x' }), 'NOT_YOUR_TURN');
});

test('unknown players are rejected', () => {
  const state = scenario({ n: 2 });
  rejects(() => act(state, { type: 'draw', playerId: 'ghost', source: 'draw' }), 'NOT_IN_ROOM');
});

test('draw -> discard moves the turn on and keeps 13 cards', () => {
  const state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  const drawBefore = state.round.drawPile.length;
  const afterDraw = act(state, { type: 'draw', playerId: p, source: 'draw' });
  assert.equal(afterDraw.state.round.hands[p].length, 14);
  assert.equal(afterDraw.state.round.drawPile.length, drawBefore - 1);
  assert.equal(afterDraw.state.round.phase, 'awaiting-discard');

  const discardId = anyCard(afterDraw.state, p);
  const afterDiscard = act(afterDraw.state, { type: 'discard', playerId: p, cardId: discardId });
  assert.equal(afterDiscard.state.round.hands[p].length, 13);
  assert.equal(afterDiscard.state.round.discardPile.at(-1).id, discardId);
  assert.notEqual(afterDiscard.state.round.currentPlayerId, p);
  assert.equal(afterDiscard.state.round.phase, 'awaiting-draw');
  assert.equal(afterDiscard.state.round.turnsTaken[p], 1);
  assert.ok(eventNames(afterDiscard).includes('player-turn'));
});

test('a player cannot draw twice in a turn', () => {
  const state = scenario({ n: 2 });
  const p = state.round.currentPlayerId;
  const { state: s1 } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  rejects(() => act(s1, { type: 'draw', playerId: p, source: 'draw' }), 'ALREADY_DRAWN');
  rejects(() => act(s1, { type: 'draw', playerId: p, source: 'discard' }), 'ALREADY_DRAWN');
});

test('discard before drawing is rejected, and a card not in hand cannot be discarded', () => {
  const state = scenario({ n: 2 });
  const p = state.round.currentPlayerId;
  rejects(() => act(state, { type: 'discard', playerId: p, cardId: anyCard(state, p) }), 'MUST_DRAW_FIRST');
  const { state: s1 } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  rejects(() => act(s1, { type: 'discard', playerId: p, cardId: 'D1-X-1' }), 'CARD_NOT_IN_HAND');
  const opponent = state.seatOrder.find((id) => id !== p);
  rejects(() => act(s1, { type: 'discard', playerId: p, cardId: anyCard(s1, opponent) }), 'CARD_NOT_IN_HAND');
});

test('a second discard in the same turn is rejected', () => {
  const state = scenario({ n: 2 });
  const p = state.round.currentPlayerId;
  const { state: s1 } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  const { state: s2 } = act(s1, { type: 'discard', playerId: p, cardId: anyCard(s1, p), endTurn: false });
  rejects(() => act(s2, { type: 'discard', playerId: p, cardId: anyCard(s2, p) }), 'ALREADY_DISCARDED');
  rejects(() => act(s2, { type: 'draw', playerId: p, source: 'draw' }), 'ALREADY_DISCARDED');
  const { state: s3 } = act(s2, { type: 'end-turn', playerId: p });
  assert.notEqual(s3.round.currentPlayerId, p);
  rejects(() => act(s3, { type: 'end-turn', playerId: p }), 'NOT_YOUR_TURN');
});

test('drawing from the open discard pile takes its top card (public) and keeps counts right', () => {
  const state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  const top = state.round.discardPile.at(-1);
  const { state: s1, events } = act(state, { type: 'draw', playerId: p, source: 'discard' });
  assert.ok(s1.round.hands[p].some((c) => c.id === top.id));
  assert.equal(s1.round.discardPile.length, 0);
  assert.equal(s1.round.drawPile.length, state.round.drawPile.length, 'draw pile untouched');
  const drawn = events.find((e) => e.name === 'card-drawn');
  assert.equal(drawn.payload.card.id, top.id, 'public event shows the face-up discard');
  assert.equal(drawn.to, 'all');
});

test('drawing from the closed pile never reveals the card in public events', () => {
  const state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  const { state: s1, events } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  const drawnId = s1.round.lastDrawnId;
  const publicJson = JSON.stringify(events.filter((e) => e.to === 'all'));
  assert.ok(!publicJson.includes(drawnId));
  const privateEvent = events.find((e) => e.name === 'hand-updated');
  assert.equal(privateEvent.to, p);
  assert.ok(JSON.stringify(privateEvent.payload).includes(drawnId));
});

test('when the draw pile is empty the discard pile is reshuffled (top card stays)', () => {
  const state = scenario({ n: 2 });
  const p = state.round.currentPlayerId;
  const round = state.round;
  // move the draw pile into the discard pile
  round.discardPile.unshift(...round.drawPile);
  round.drawPile = [];
  const top = round.discardPile.at(-1);
  const { state: s1 } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  assert.equal(s1.round.discardPile.length, 1);
  assert.equal(s1.round.discardPile[0].id, top.id);
  assert.equal(s1.round.hands[p].length, 14);
});

test('both piles empty -> PILE_EMPTY', () => {
  const state = scenario({ n: 2 });
  const p = state.round.currentPlayerId;
  state.round.drawPile = [];
  state.round.discardPile = [state.round.discardPile[0]];
  rejects(() => act(state, { type: 'draw', playerId: p, source: 'draw' }), 'PILE_EMPTY');
});

test('a rejected action leaves the previous state untouched, and actions never mutate their input', () => {
  const state = scenario({ n: 3 });
  const snapshot = JSON.stringify(state);
  const p = state.round.currentPlayerId;
  rejects(() => act(state, { type: 'discard', playerId: p, cardId: 'nope' }), 'MUST_DRAW_FIRST');
  act(state, { type: 'draw', playerId: p, source: 'draw' });
  assert.equal(JSON.stringify(state), snapshot);
});

test('unknown action types are rejected', () => {
  const state = scenario({ n: 2 });
  rejects(() => act(state, { type: 'cheat', playerId: state.round.currentPlayerId }), 'UNKNOWN_ACTION');
  rejects(() => act(state, null), 'UNKNOWN_ACTION');
});

test('arrange accepts exactly the hand and rejects anything else', () => {
  const state = scenario({ n: 2 });
  const p = state.seatOrder[0];
  const hand = state.round.hands[p].map((c) => c.id);
  const { state: s1 } = act(state, { type: 'arrange', playerId: p, groups: [hand.slice(0, 5), hand.slice(5)] });
  assert.equal(s1.round.groups[p].length, 2);
  rejects(() => act(state, { type: 'arrange', playerId: p, groups: [hand.slice(1)] }), 'INVALID_ARRANGEMENT');
  rejects(() => act(state, { type: 'arrange', playerId: p, groups: [[...hand, hand[0]]] }), 'INVALID_ARRANGEMENT');
  const opp = state.seatOrder[1];
  const stolen = [...hand.slice(1), state.round.hands[opp][0].id];
  rejects(() => act(state, { type: 'arrange', playerId: p, groups: [stolen] }), 'INVALID_ARRANGEMENT');
});

test('arrange works out of turn (it is private bookkeeping)', () => {
  const state = scenario({ n: 3 });
  const other = state.seatOrder.find((id) => id !== state.round.currentPlayerId);
  const hand = state.round.hands[other].map((c) => c.id);
  assert.doesNotThrow(() => act(state, { type: 'arrange', playerId: other, groups: [hand] }));
});

// ---------------------------------------------------------------------------
// 16 + 17. Drops
// ---------------------------------------------------------------------------

test('first drop: 20 points, player leaves the round, others are told', () => {
  const state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  const { state: s1, events } = act(state, { type: 'drop', playerId: p });
  assert.equal(s1.round.playerStatus[p], 'dropped_first');
  assert.equal(s1.round.penalties[p].penalty, 20);
  assert.equal(s1.players[p].drops, 1);
  assert.notEqual(s1.round.currentPlayerId, p);
  const evt = events.find((e) => e.name === 'player-drop');
  assert.deepEqual([evt.payload.type, evt.payload.penalty, evt.to], ['first', 20, 'all']);
  // the dropped player can no longer act
  rejects(() => act(s1, { type: 'draw', playerId: p, source: 'draw' }), 'NOT_IN_ROUND');
});

test('middle drop: 40 points once the player has completed a turn', () => {
  let state = scenario({ n: 3 });
  const order = [];
  // everybody plays one turn
  for (let i = 0; i < 3; i += 1) {
    const p = state.round.currentPlayerId;
    order.push(p);
    state = playTurn(state, p, state.round.hands[p][0].id).state;
  }
  const p = state.round.currentPlayerId;
  assert.equal(p, order[0]);
  const { state: s1 } = act(state, { type: 'drop', playerId: p });
  assert.equal(s1.round.playerStatus[p], 'dropped_middle');
  assert.equal(s1.round.penalties[p].penalty, 40);
});

test('a drop is only possible at the start of your own turn, before drawing', () => {
  const state = scenario({ n: 2 });
  const p = state.round.currentPlayerId;
  const { state: s1 } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  rejects(() => act(s1, { type: 'drop', playerId: p }), 'DROP_NOT_ALLOWED');
});

test('a player never receives both drop penalties in one round', () => {
  const state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  const { state: s1 } = act(state, { type: 'drop', playerId: p });
  rejects(() => act(s1, { type: 'drop', playerId: p }), 'NOT_IN_ROUND');
  assert.equal(s1.round.penalties[p].penalty, 20);
});

test('when everyone else has dropped the last player wins the round with 0', () => {
  let state = scenario({ n: 3 });
  const first = state.round.currentPlayerId;
  state = act(state, { type: 'drop', playerId: first }).state;
  const second = state.round.currentPlayerId;
  const r = act(state, { type: 'drop', playerId: second });
  const last = state.seatOrder.find((id) => id !== first && id !== second);
  assert.equal(r.state.stage, 'between-rounds');
  assert.equal(r.state.round.result.winnerId, last);
  assert.equal(r.state.round.result.endReason, 'last_player_standing');
  assert.equal(r.state.players[last].score, 0);
  assert.equal(r.state.players[first].score, 20);
  assert.equal(r.state.players[second].score, 20);
  assert.ok(eventNames(r).includes('round-completed'));
  assert.ok(eventNames(r).includes('scoreboard-updated'));
});

// ---------------------------------------------------------------------------
// 13 + 14 + 15. Declarations
// ---------------------------------------------------------------------------

test('valid declaration: declarer wins, opponents pay for unmatched cards only', () => {
  const state = scenario({
    n: 3,
    hands: {
      p1: VALID_HAND,
      p2: '5H 5D 5C 5S 6H 6D 6C 2H 2D 2C 3H 3D KH', // valid except K -> 10 points? see below
      p3: '4H 4D 4C 4S QH QD QC JH JD 3C 3S 9H/2 9D/2',
    },
    openJoker: 'A',
  });
  state.round.currentPlayerId = 'p1';
  const { state: s1, events } = act(state, { type: 'declare', playerId: 'p1', groups: groupIds(VALID_GROUPS) });
  assert.equal(s1.stage, 'between-rounds');
  assert.equal(s1.round.result.winnerId, 'p1');
  assert.equal(s1.round.result.endReason, 'valid_declaration');
  assert.equal(s1.players.p1.score, 0);
  // p2: LIFE 5555, 666, 222 + 3,3 + K unmatched -> 3+3+10 = 16
  assert.equal(s1.players.p2.score, 16);
  // p3: LIFE 4444, QQQ, J,J + 3,3 + 9,9 -> 10+10+3+3+9+9 = 44
  assert.equal(s1.players.p3.score, 44);
  const done = events.find((e) => e.name === 'round-completed');
  assert.equal(done.payload.winnerId, 'p1');
  assert.ok(done.payload.reveals.p1 && done.payload.reveals.p2 && done.payload.reveals.p3);
  const decl = events.find((e) => e.name === 'declaration-result');
  assert.deepEqual([decl.payload.valid, decl.payload.penalty], [true, 0]);
});

test('declaring is also possible right after discarding (before ending the turn)', () => {
  const state = scenario({ n: 2, hands: { p1: VALID_HAND, p2: JUNK_HAND }, openJoker: 'A' });
  state.round.currentPlayerId = 'p1';
  // draw an arbitrary card, discard it, but do not end the turn
  let s = act(state, { type: 'draw', playerId: 'p1', source: 'draw' }).state;
  s = act(s, { type: 'discard', playerId: 'p1', cardId: s.round.lastDrawnId, endTurn: false }).state;
  assert.equal(s.round.phase, 'awaiting-end-turn');
  const r = act(s, { type: 'declare', playerId: 'p1', groups: groupIds(VALID_GROUPS) });
  assert.equal(r.state.round.result.winnerId, 'p1');
});

test('declaring with 14 cards (before discarding) is rejected', () => {
  const state = scenario({ n: 2, hands: { p1: VALID_HAND, p2: JUNK_HAND } });
  state.round.currentPlayerId = 'p1';
  const { state: s1 } = act(state, { type: 'draw', playerId: 'p1', source: 'draw' });
  rejects(() => act(s1, { type: 'declare', playerId: 'p1', groups: groupIds(VALID_GROUPS) }), 'DECLARATION_NOT_ALLOWED');
});

test('invalid declaration: exactly 40 points, announced to all, declarer is removed, round continues', () => {
  const state = scenario({ n: 3, hands: { p1: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 10C JK1' } });
  state.round.currentPlayerId = 'p1';
  const groups = groupIds(['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']); // no natural LIFE
  const { state: s1, events } = act(state, { type: 'declare', playerId: 'p1', groups });
  assert.equal(s1.stage, 'in-round');
  assert.equal(s1.round.penalties.p1.penalty, 40);
  assert.equal(s1.round.penalties.p1.reason, 'invalid_declaration');
  assert.equal(s1.round.playerStatus.p1, 'removed_invalid_declaration');
  assert.notEqual(s1.round.currentPlayerId, 'p1');
  const pub = events.find((e) => e.name === 'declaration-result');
  assert.deepEqual([pub.to, pub.payload.valid, pub.payload.penalty], ['all', false, 40]);
  const errs = events.find((e) => e.name === 'declaration-errors');
  assert.equal(errs.to, 'p1', 'failure details are private to the declarer');
  assert.ok(!JSON.stringify(pub).includes('7H'), 'attempted groups are never broadcast');
});

test('the invalid declaration penalty cannot be applied twice, and applies to the cumulative score once', () => {
  const state = scenario({ n: 2, config: { invalidDeclarationPolicy: 'continue-declarer' }, hands: { p1: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 10C JK1' } });
  state.round.currentPlayerId = 'p1';
  const bad = groupIds(['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']);
  const r1 = act(state, { type: 'declare', playerId: 'p1', groups: bad });
  assert.equal(r1.state.round.penalties.p1.penalty, 40);
  assert.equal(r1.state.round.playerStatus.p1, 'playing', 'continue-declarer keeps the player in');
  assert.equal(r1.state.round.currentPlayerId, 'p1');
  const r2 = act(r1.state, { type: 'declare', playerId: 'p1', groups: bad });
  const decl = r2.events.find((e) => e.name === 'declaration-result');
  assert.equal(decl.payload.penalty, 0, 'no second penalty');
  assert.equal(r2.state.round.penalties.p1.penalty, 40);
  // p1 is out, p2 is the last player standing; p1 total stays 40
  assert.equal(r2.state.players.p1.score, 40);
  assert.equal(r2.state.round.result.winnerId, 'p2');
});

test('end-round policy: the round ends with no winner, only the declarer pays', () => {
  const state = scenario({ n: 3, config: { invalidDeclarationPolicy: 'end-round' }, hands: { p1: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 10C JK1' } });
  state.round.currentPlayerId = 'p1';
  const r = act(state, { type: 'declare', playerId: 'p1', groups: groupIds(['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']) });
  assert.equal(r.state.round.result.endReason, 'invalid_declaration_end');
  assert.equal(r.state.round.result.winnerId, null);
  assert.equal(r.state.players.p1.score, 40);
  assert.equal(r.state.players.p2.score, 0);
  assert.equal(r.state.players.p3.score, 0);
});

test('a failed declaration where only one player remains hands that player the round', () => {
  const state = scenario({ n: 2, hands: { p1: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 10C JK1' } });
  state.round.currentPlayerId = 'p1';
  const r = act(state, { type: 'declare', playerId: 'p1', groups: groupIds(['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']) });
  assert.equal(r.state.round.result.winnerId, 'p2');
  assert.equal(r.state.players.p1.score, 40);
  assert.equal(r.state.players.p2.score, 0);
});

// ---------------------------------------------------------------------------
// 20 + 21. Elimination, game completion, dealer rotation
// ---------------------------------------------------------------------------

test('crossing 201 eliminates, the game completes with one player left, scoreboard is final', () => {
  const state = scenario({ n: 2, hands: { p1: VALID_HAND, p2: JUNK_HAND } });
  state.players.p2.score = 185; // 185 + 70 unmatched points must reach 201+
  state.round.currentPlayerId = 'p1';
  const r = act(state, { type: 'declare', playerId: 'p1', groups: groupIds(VALID_GROUPS) });
  const names = eventNames(r);
  assert.equal(r.state.players.p2.status, 'eliminated');
  assert.ok(r.state.players.p2.score >= 201);
  assert.equal(r.state.stage, 'completed');
  assert.equal(r.state.winnerId, 'p1');
  assert.ok(names.includes('player-eliminated'));
  const done = r.events.find((e) => e.name === 'game-completed');
  assert.equal(done.payload.winnerId, 'p1');
  assert.equal(done.payload.totalRounds, 1);
  assert.equal(done.payload.eliminatedHistory.length, 1);
  assert.equal(done.payload.finalScoreboard.find((s) => s.playerId === 'p1').isWinner, true);
  rejects(() => act(r.state, { type: 'start-next-round' }), 'GAME_FINISHED');
});

test('185 + a 20 point first drop = 205 eliminates when the round is settled', () => {
  let state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  state.players[p].score = 185;
  state = act(state, { type: 'drop', playerId: p }).state;
  assert.equal(state.players[p].score, 185, 'cumulative scores change once, at the end of the round');
  assert.equal(state.round.penalties[p].penalty, 20, 'the round penalty is visible straight away');
  assert.equal(state.stage, 'in-round', 'two players still in the round');
  const r = act(state, { type: 'drop', playerId: state.round.currentPlayerId });
  assert.equal(r.state.players[p].score, 205);
  assert.equal(r.state.players[p].status, 'eliminated');
  assert.equal(r.state.players[p].eliminatedInRound, 1);
  assert.ok(r.events.some((e) => e.name === 'player-eliminated' && e.payload.playerId === p));
  assert.equal(r.state.stage, 'between-rounds', 'two active players remain, so the game goes on');
});

test('multiple players eliminated in one round; eliminated players are skipped in later rounds', () => {
  let state = scenario({ n: 4 });
  // The first three players to act drop, so the fourth wins the round.
  const start = state.round.order.indexOf(state.round.currentPlayerId);
  const turnOrder = [0, 1, 2, 3].map((i) => state.round.order[(start + i) % 4]);
  state.players[turnOrder[0]].score = 190; // -> 210 after a first drop
  state.players[turnOrder[1]].score = 195; // -> 215
  while (state.stage === 'in-round') {
    state = act(state, { type: 'drop', playerId: state.round.currentPlayerId }).state;
  }
  assert.equal(state.stage, 'between-rounds');
  assert.equal(state.round.result.winnerId, turnOrder[3]);
  const survivors = state.seatOrder.filter((id) => state.players[id].status === 'active');
  assert.deepEqual(survivors.sort(), [turnOrder[2], turnOrder[3]].sort());
  assert.equal(state.players[turnOrder[0]].status, 'eliminated');
  assert.equal(state.players[turnOrder[1]].status, 'eliminated');
  assert.equal(state.round.result.results.filter((r) => r.eliminated).length, 2);

  const nextRound = act(state, { type: 'start-next-round' });
  const round2 = nextRound.state.round;
  assert.equal(round2.no, 2);
  assert.deepEqual([...round2.order].sort(), [...survivors].sort(), 'eliminated players are out of round 2');
  for (const id of state.seatOrder) {
    if (!survivors.includes(id)) rejects(() => act(nextRound.state, { type: 'draw', playerId: id, source: 'draw' }), 'PLAYER_ELIMINATED');
  }
  // dealer rotated clockwise to a surviving player different from before
  assert.notEqual(round2.dealerId, state.round.dealerId);
  assert.ok(survivors.includes(round2.dealerId));
  // history is preserved
  assert.equal(nextRound.state.history.length, 1);
});

test('start-next-round is only allowed between rounds', () => {
  const state = scenario({ n: 2 });
  rejects(() => act(state, { type: 'start-next-round' }), 'NOT_BETWEEN_ROUNDS');
});

test('dealer rotates every round', () => {
  let state = scenario({ n: 3 });
  const dealers = [state.round.dealerId];
  for (let r = 0; r < 3; r += 1) {
    while (state.stage === 'in-round') state = act(state, { type: 'drop', playerId: state.round.currentPlayerId }).state;
    state = act(state, { type: 'start-next-round' }).state;
    dealers.push(state.round.dealerId);
    // keep scores low so nobody is eliminated
    for (const id of state.seatOrder) state.players[id].score = 0;
  }
  for (let i = 1; i < dealers.length; i += 1) {
    const prevIdx = state.seatOrder.indexOf(dealers[i - 1]);
    assert.equal(dealers[i], state.seatOrder[(prevIdx + 1) % 3]);
  }
});

// ---------------------------------------------------------------------------
// 22. 1 CARD TO WIN through the engine
// ---------------------------------------------------------------------------

test('1 CARD TO WIN: the server accepts it only when eligible, shows only a flag, can be turned off', () => {
  const state = scenario({
    n: 3,
    hands: {
      p1: '7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 9C 9S KH',
      p2: '2H 3H 4H 5H 6H 7H/2 8H/2 9H/2 10H JH QH KD 2D',
    },
  });
  const { state: s1, events } = act(state, { type: 'one-card-to-win', playerId: 'p1', active: true });
  assert.equal(s1.round.oneCardToWin.p1, true);
  const evt = events.find((e) => e.name === 'one-card-to-win');
  assert.deepEqual(evt, { name: 'one-card-to-win', to: 'all', payload: { playerId: 'p1', active: true } });
  rejects(() => act(state, { type: 'one-card-to-win', playerId: 'p2', active: true }), 'ONE_CARD_NOT_ELIGIBLE');

  // other players see the flag but nothing about the cards
  const viewOfP2 = viewFor(s1, 'p2');
  assert.equal(viewOfP2.players.find((p) => p.playerId === 'p1').oneCardToWin, true);
  assert.ok(!JSON.stringify(viewOfP2).includes('D1-H-K'));

  // deactivate
  const { state: s2 } = act(s1, { type: 'one-card-to-win', playerId: 'p1', active: false });
  assert.equal(s2.round.oneCardToWin.p1, false);
});

test('the private view tells the client whether 1 CARD TO WIN may be pressed (server-side decision)', () => {
  const state = scenario({
    n: 2,
    hands: { p1: '7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 9C 9S KH', p2: JUNK_HAND },
    openJoker: 'A',
  });
  assert.equal(viewFor(state, 'p1').me.oneCardEligible, true);
  assert.equal(viewFor(state, 'p2').me.oneCardEligible, false);
  const { state: s1 } = act({ ...state, round: { ...state.round, currentPlayerId: 'p1' } }, { type: 'draw', playerId: 'p1', source: 'draw' });
  assert.equal(viewFor(s1, 'p1').me.oneCardEligible, false, 'not evaluated while holding 14 cards');
});

test('1 CARD TO WIN switches itself off when a discard breaks the hand, stays on when it does not', () => {
  const base = scenario({
    n: 2,
    hands: { p1: '7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 9C 9S KH', p2: JUNK_HAND },
    openJoker: 'A',
  });
  base.round.currentPlayerId = 'p1';
  setDrawTop(base, '2C');
  let s = act(base, { type: 'one-card-to-win', playerId: 'p1', active: true }).state;
  assert.equal(s.players.p1.score, 0, 'the flag never touches scoring');
  s = act(s, { type: 'draw', playerId: 'p1', source: 'draw' }).state;

  // discarding the K leaves 7777 8888 9999 + 2C: still one card away
  const keep = act(s, { type: 'discard', playerId: 'p1', cardId: 'D1-H-K', endTurn: false });
  assert.equal(keep.state.round.oneCardToWin.p1, true);
  assert.ok(!keep.events.some((e) => e.name === 'one-card-to-win'));

  // discarding a 7 leaves two stray cards (K and 2C): the flag is cleared and everyone is told
  const broken = act(s, { type: 'discard', playerId: 'p1', cardId: 'D1-H-7', endTurn: false });
  assert.equal(broken.state.round.oneCardToWin.p1, false);
  const evt = broken.events.find((e) => e.name === 'one-card-to-win');
  assert.deepEqual([evt.to, evt.payload.active], ['all', false]);
});

// ---------------------------------------------------------------------------
// timers (the platform schedules them, the engine enforces the outcome)
// ---------------------------------------------------------------------------

test('nextTimer tells the platform whose turn timer to run', () => {
  const state = scenario({ n: 2 });
  assert.deepEqual(nextTimer(state), {
    kind: 'turn', playerId: state.round.currentPlayerId, seconds: 60, roundNo: 1, turnNo: 1,
  });
  const noTimer = scenario({ n: 2, config: { turnTimerSeconds: 0 } });
  assert.equal(nextTimer(noTimer), null);
});

test('a timeout auto-plays the turn, and repeated timeouts auto-drop the player', () => {
  let state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  const handBefore = state.round.hands[p].map((c) => c.id).sort();
  state = act(state, { type: 'timeout', playerId: p }).state;
  assert.equal(state.round.hands[p].length, 13);
  assert.notEqual(state.round.currentPlayerId, p);
  assert.equal(state.round.timeouts[p], 1);
  assert.deepEqual(state.round.hands[p].map((c) => c.id).sort(), handBefore, 'auto-play returns the drawn card');

  // the timer fires for the wrong player -> rejected
  rejects(() => act(state, { type: 'timeout', playerId: p }), 'NOT_YOUR_TURN');

  // force the timeout counter near the limit
  state.round.timeouts[state.round.currentPlayerId] = 2;
  const q = state.round.currentPlayerId;
  const r = act(state, { type: 'timeout', playerId: q });
  assert.equal(r.state.round.playerStatus[q], 'dropped_first');
  assert.ok(r.events.find((e) => e.name === 'player-drop').payload.auto);
});

// ---------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------

test('views never contain opponents\' cards or the draw pile', () => {
  const state = scenario({ n: 4 });
  for (const viewer of state.seatOrder) {
    const json = JSON.stringify(viewFor(state, viewer));
    for (const other of state.seatOrder) {
      if (other === viewer) continue;
      for (const c of state.round.hands[other]) assert.ok(!json.includes(`"${c.id}"`), `${viewer} sees ${c.id}`);
    }
    for (const c of state.round.drawPile) assert.ok(!json.includes(`"${c.id}"`), 'draw pile leaked');
    const view = viewFor(state, viewer);
    assert.equal(view.me.hand.length, 13);
    assert.equal(view.round.drawPileCount, state.round.drawPile.length);
    assert.ok(view.players.every((p) => p.handCount === 13));
    assert.equal(JSON.stringify(view).includes('drawPile"'), false);
  }
});

test('every event addressed to everyone is free of private cards', () => {
  const { state, events } = createGame({ players: playersOf(3), rng: seededRng(11) });
  const publicJson = JSON.stringify(events.filter((e) => e.to === 'all'));
  for (const hand of Object.values(state.round.hands)) {
    for (const c of hand) assert.ok(!publicJson.includes(`"${c.id}"`));
  }
  for (const c of state.round.drawPile) assert.ok(!publicJson.includes(`"${c.id}"`));
  // each private hand event goes only to its owner
  for (const e of events.filter((x) => x.name === 'hand-updated')) {
    const owner = e.to;
    for (const [id, hand] of Object.entries(state.round.hands)) {
      if (id === owner) continue;
      for (const c of hand) assert.ok(!JSON.stringify(e.payload).includes(`"${c.id}"`));
    }
  }
});

test('an eliminated player gets no hand in the next round view', () => {
  let state = scenario({ n: 3 });
  const p = state.round.currentPlayerId;
  state.players[p].score = 190;
  state = act(state, { type: 'drop', playerId: p }).state; // 190+20 = 210 -> eliminated at round end
  while (state.stage === 'in-round') state = act(state, { type: 'drop', playerId: state.round.currentPlayerId }).state;
  state = act(state, { type: 'start-next-round' }).state;
  assert.equal(viewFor(state, p).me, null);
  assert.equal(viewFor(state, p).players.find((x) => x.playerId === p).status, 'eliminated');
});

test('the open pile history: everyone sees who threw which card, and who picked one up again', () => {
  const state = scenario({ n: 3 });
  const p1 = state.round.currentPlayerId;
  const s1 = act(state, { type: 'draw', playerId: p1, source: 'draw' }).state;
  const thrown = anyCard(s1, p1);
  const s2 = act(s1, { type: 'discard', playerId: p1, cardId: thrown }).state;
  const p2 = s2.round.currentPlayerId;

  const others = Object.keys(s2.players).filter((id) => id !== p1);
  for (const viewer of [p1, ...others]) {
    const { discards } = viewFor(s2, viewer).round;
    assert.equal(discards.length, 1);
    assert.deepEqual([discards[0].playerId, discards[0].card.id, discards[0].takenBy], [p1, thrown, null]);
  }

  // the next player takes it back from the open pile: the history says so
  const s3 = act(s2, { type: 'draw', playerId: p2, source: 'discard' }).state;
  const after = viewFor(s3, p1).round.discards;
  assert.deepEqual([after[0].card.id, after[0].takenBy], [thrown, p2]);
  // only cards that were thrown are in it, never anybody's hand
  const hands = Object.entries(s3.round.hands).flatMap(([, h]) => h.map((c) => c.id)).filter((id) => id !== thrown);
  for (const id of hands) assert.ok(!JSON.stringify(after).includes(`"${id}"`));
});
