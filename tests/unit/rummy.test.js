'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMeld } = require('../../src/games/rummy/melds');
const { validateDeclaration } = require('../../src/games/rummy/declaration');
const { scoreHand } = require('../../src/games/rummy/scoring');
const { findDeclaration } = require('../../src/games/rummy/solver');
const { resolveConfig } = require('../../src/games/rummy/rummy.config');
const rummy = require('../../src/games/rummy');
const { cards, groupIds, scenario, act, setDiscardTop, playersOf, seededRng } = require('../helpers/cards');

/** ctx for a rummy hand; `open` is the face-up wild-joker number */
const rctx = (open = 'Z', overrides = {}) => ({ config: resolveConfig(overrides), openJokerRank: open });
const kind = (str, open) => evaluateMeld(cards(str), rctx(open));
const codes = (r) => r.errors.map((e) => e.code);

// ---------------------------------------------------------------------------
// melds
// ---------------------------------------------------------------------------

test('pure sequence: 3+ consecutive cards of one suit, no joker', () => {
  assert.equal(kind('4H 5H 6H'), 'pure');
  assert.equal(kind('4H 5H 6H 7H 8H'), 'pure');
  assert.equal(kind('AS 2S 3S'), 'pure', 'ace low');
  assert.equal(kind('QS KS AS'), 'pure', 'ace high');
  assert.equal(kind('KS AS 2S'), null, 'no wrap-around');
  assert.equal(kind('4H 5D 6H'), null, 'mixed suits');
  assert.equal(kind('4H 6H 7H'), null, 'a gap without a joker');
  assert.equal(kind('4H 5H'), null, 'too short');
});

test('sequence with jokers: gaps and ends can be filled', () => {
  assert.equal(kind('4H JK1 6H'), 'seq');
  assert.equal(kind('4H 5H JK1'), 'seq');
  assert.equal(kind('4H 5H JK1 JK2'), 'seq');
  assert.equal(kind('KH JK1 JK2'), 'seq', 'one real card and two jokers');
  assert.equal(kind('JK1 JK2 JK1/2'), null, 'jokers alone are not a meld');
  assert.equal(kind('4H 4H/2 5H'), null, 'two identical cards cannot both stand in one sequence');
});

test('set: 3 or 4 cards of one number in different suits', () => {
  assert.equal(kind('7H 7D 7C'), 'set');
  assert.equal(kind('7H 7D 7C 7S'), 'set');
  assert.equal(kind('7H 7H/2 7D'), null, 'two hearts');
  assert.equal(kind('7H 7D 7C 7S 7H/2'), null, 'more than four');
  assert.equal(kind('7H 7D JK1'), 'set');
  assert.equal(kind('7H 8D 9C'), null);
});

test('the wild-joker number: usable as a joker, or as its own card in a pure sequence', () => {
  // 5 is the wild-joker number
  assert.equal(kind('4H 5H 6H', '5'), 'pure', 'the 5 of hearts is just a 5 here');
  assert.equal(kind('4H 5D 6H', '5'), 'seq', 'the 5 of diamonds stands in for the missing card');
  assert.equal(kind('9H 9D 5C', '5'), 'set', 'a wild 5 completes a set of nines');
});

// ---------------------------------------------------------------------------
// showing (declaring)
// ---------------------------------------------------------------------------

const WIN = '4H 5H 6H 7S 8S JK1 9D 9C 9S 2D 2C 2S 2H';
const WIN_GROUPS = ['4H 5H 6H', '7S 8S JK1', '9D 9C 9S', '2D 2C 2S 2H'];

test('a valid show: a pure sequence, a second sequence, and every other card in melds', () => {
  const r = validateDeclaration({ hand: cards(WIN), groups: groupIds(WIN_GROUPS), ctx: rctx('A') });
  assert.deepEqual(codes(r), []);
  assert.deepEqual(r.groups.map((g) => g.kind), ['pure', 'seq', 'set', 'set']);
});

test('a show without a pure sequence is refused', () => {
  const hand = '4H 5H JK1 7S 8S JK2 9D 9C 9S 2D 2C 2S 2H';
  const r = validateDeclaration({ hand: cards(hand), groups: groupIds(['4H 5H JK1', '7S 8S JK2', '9D 9C 9S', '2D 2C 2S 2H']), ctx: rctx('A') });
  assert.deepEqual(codes(r), ['NO_PURE_SEQUENCE']);
});

test('a show with a pure sequence but no second sequence is refused', () => {
  const hand = '4H 5H 6H 7D 7C 7S 9D 9C 9S 2D 2C 2S 2H';
  const r = validateDeclaration({ hand: cards(hand), groups: groupIds(['4H 5H 6H', '7D 7C 7S', '9D 9C 9S', '2D 2C 2S 2H']), ctx: rctx('A') });
  assert.deepEqual(codes(r), ['NEED_SECOND_SEQUENCE']);
});

test('a show with a stray card, a wrong card or a repeated card is refused', () => {
  const stray = validateDeclaration({ hand: cards(WIN), groups: groupIds(['4H 5H 6H', '7S 8S JK1', '9D 9C 9S']), ctx: rctx('A') });
  assert.ok(codes(stray).includes('MISSING_CARDS'));
  const bad = validateDeclaration({ hand: cards(WIN), groups: groupIds(['4H 5H 6H', '7S 8S JK1', '9D 9C 9S 2D', '2C 2S 2H']), ctx: rctx('A') });
  assert.ok(codes(bad).includes('INVALID_GROUP'));
  const twice = validateDeclaration({ hand: cards(WIN), groups: groupIds(['4H 5H 6H', '4H 7S 8S', 'JK1 9D 9C', '9S 2D 2C 2S 2H']), ctx: rctx('A') });
  assert.ok(codes(twice).includes('DUPLICATE_CARD'));
  const wrongCount = validateDeclaration({ hand: cards(WIN).slice(0, 12), groups: [], ctx: rctx('A') });
  assert.deepEqual(codes(wrongCount), ['WRONG_CARD_COUNT']);
});

test('the solver finds a winning arrangement when one exists, and none otherwise', () => {
  const groups = findDeclaration(cards(WIN), rctx('A'));
  assert.equal(groups.flatMap((g) => g.cardIds).length, 13);
  assert.equal(findDeclaration(cards('4H 5H 6H 7S 8S JK1 9D 9C 9S KD QC 3D 2H'), rctx('A')), null);
});

// ---------------------------------------------------------------------------
// counting the points
// ---------------------------------------------------------------------------

test('count: a pure sequence and a second sequence make every meld free; the rest is counted', () => {
  const score = scoreHand(cards('4H 5H 6H 7S 8S JK1 9D 9C 9S KD QC 3D 2H'), rctx('A'));
  assert.equal(score.points, 10 + 10 + 3 + 2);
  assert.equal(score.reason, 'unmatched_cards');
  assert.deepEqual(score.groups.map((g) => g.kind).sort(), ['pure', 'seq', 'set']);
});

test('count: with only a pure sequence, sets and loose cards all count', () => {
  const score = scoreHand(cards('4H 5H 6H 7D 7C 7S 9D 9C 9S KD QC 3D 2H'), rctx('A'));
  assert.equal(score.points, 21 + 27 + 10 + 10 + 3 + 2 - 0 - 0 + 0 > 80 ? 80 : 21 + 27 + 10 + 10 + 3 + 2);
  assert.equal(score.points, 73, 'only 4,5,6 of hearts are free');
  assert.deepEqual(score.groups.map((g) => g.kind), ['pure']);
});

test('count: no pure sequence means every card counts, never more than 80', () => {
  const hand = cards('4H 5H JK1 7S 8S JK2 9D 9C 9H KD QC KS KC');
  const score = scoreHand(hand, rctx('A'));
  assert.equal(score.reason, 'no_pure_sequence');
  assert.equal(score.points, 80, 'capped');
  const none = cards('2H 5D 7C KS 9D 2D 4C 6S 8H 10D JC AS 3H'); // no three consecutive cards of one suit
  assert.equal(scoreHand(none, rctx('Z')).points, 80);
  assert.equal(scoreHand(none, rctx('Z', { maxRoundPenalty: 1000 })).points, 86, 'the cap is a setting');
});

test('count: a wild-joker card left over is worth nothing', () => {
  // 5 is the wild-joker number. Two pure sequences; the lone 5 of diamonds fits no meld.
  const score = scoreHand(cards('7S 8S 9S 10H JH QH 2D 3C 8D KC 5D 4S 9C'), rctx('5'));
  assert.equal(score.points, 2 + 3 + 8 + 10 + 4 + 9, 'the 5 of diamonds adds nothing');
  assert.ok(score.unmatchedIds.includes('D1-D-5'));
});

test('count: wild-joker cards help the player build melds, so they are never wasted', () => {
  const score = scoreHand(cards('4H 5H 6H 7S 8S 9S 2D 3C 8D KC JD 5D 10C'), rctx('5'));
  assert.equal(score.points, 33, 'the 5s act as jokers inside a 10-J-Q-K sequence of clubs');
});

test('count: the arrangement is the best one for the player (jokers go where they save the most)', () => {
  // pure 3-4-5 of hearts; K,K and a joker can make a set of kings; the other card is a 6
  const score = scoreHand(cards('3H 4H 5H 7S 8S 9S KD KC JK1 2D 2C 2S 6D'), rctx('A'));
  assert.equal(score.points, 6);
});

// ---------------------------------------------------------------------------
// the shared engine playing Rummy
// ---------------------------------------------------------------------------

test('rummy configuration: standard penalties and the room limit', () => {
  const c = resolveConfig();
  assert.deepEqual([c.firstDropPenalty, c.middleDropPenalty, c.invalidDeclarationPenalty, c.maxRoundPenalty], [20, 40, 80, 80]);
  assert.equal(resolveConfig({ eliminationThreshold: 101 }).eliminationThreshold, 101);
  assert.throws(() => resolveConfig({ nope: 1 }), { code: 'INVALID_CONFIG' });
});

for (const n of [2, 3, 4, 5]) {
  test(`${n}-player Rummy deals 13 cards each from ${n === 2 ? 'one deck' : 'two decks'}`, () => {
    const { state, events } = rummy.createGame({ players: playersOf(n), rng: seededRng(n) });
    assert.equal(state.game, 'RUMMY');
    assert.equal(state.deckCount, n === 2 ? 1 : 2);
    for (const id of state.seatOrder) assert.equal(state.round.hands[id].length, 13);
    assert.ok(events.some((e) => e.name === 'cards-distributed'));
    const view = rummy.viewFor(state, state.seatOrder[0]);
    assert.equal(view.game, 'RUMMY');
    assert.deepEqual(view.features, { oneCardToWin: false });
    assert.equal(view.me.oneCardEligible, false);
  });
}

const RICH = '4H 5H 6H 7S 8S JK1 9D 9C 9S 2D 2C 2S 2H';
const JUNK = '3H 5D 7C KS QD 2D 4C 6S 8H 10D JC AS 9H';

test('a valid show wins the round; the others are counted with the rummy rules', () => {
  const state = scenario({ game: 'RUMMY', n: 2, openJoker: 'A', hands: { p1: RICH, p2: JUNK.replace(/ 2D /, ' 3D ').replace('AS', 'KH') } });
  state.round.currentPlayerId = 'p1';
  const { state: s, events } = act(state, { type: 'declare', playerId: 'p1', groups: groupIds(WIN_GROUPS) });
  assert.equal(s.round.result.winnerId, 'p1');
  assert.equal(s.round.result.endReason, 'valid_declaration');
  assert.equal(s.players.p1.score, 0);
  const loser = s.round.result.results.find((r) => r.playerId === 'p2');
  assert.equal(loser.reason, 'no_pure_sequence');
  assert.equal(loser.penalty, 80, 'a hand without a pure sequence counts in full, capped at 80');
  const done = events.find((e) => e.name === 'round-completed');
  assert.deepEqual(done.payload.reveals.p1.groups.map((g) => g.kind), ['pure', 'seq', 'set', 'set']);
});

test('a wrong show costs 80 points', () => {
  const state = scenario({ game: 'RUMMY', n: 3, openJoker: 'A', hands: { p1: '4H 5H JK1 7S 8S JK2 9D 9C 9S 2D 2C 2S 2H' } });
  state.round.currentPlayerId = 'p1';
  const bad = groupIds(['4H 5H JK1', '7S 8S JK2', '9D 9C 9S', '2D 2C 2S 2H']);
  const { state: s, events } = act(state, { type: 'declare', playerId: 'p1', groups: bad });
  assert.equal(s.round.penalties.p1.penalty, 80);
  assert.equal(s.round.playerStatus.p1, 'removed_invalid_declaration');
  const pub = events.find((e) => e.name === 'declaration-result');
  assert.deepEqual([pub.payload.valid, pub.payload.penalty], [false, 80]);
  assert.deepEqual(events.find((e) => e.name === 'declaration-errors').payload.errors.map((e) => e.code), ['NO_PURE_SEQUENCE']);
});

test('drops cost 20 then 40, and a player is out when the room limit is reached', () => {
  let state = scenario({ game: 'RUMMY', n: 2, config: { eliminationThreshold: 101 } });
  const p = state.round.currentPlayerId;
  state.players[p].score = 85;
  state = act(state, { type: 'drop', playerId: p }).state;
  assert.equal(state.round.penalties[p].penalty, 20);
  assert.equal(state.players[p].status, 'eliminated', '85 + 20 = 105 is over 101');
  assert.equal(state.stage, 'completed');
});

test('a printed joker thrown on the open pile cannot be taken', () => {
  const state = scenario({ game: 'RUMMY', n: 2 });
  const p = state.round.currentPlayerId;
  setDiscardTop(state, 'JK1');
  assert.throws(() => act(state, { type: 'draw', playerId: p, source: 'discard' }), (e) => e.code === 'JOKER_NOT_PICKABLE');
  assert.equal(act(state, { type: 'draw', playerId: p, source: 'draw' }).state.round.hands[p].length, 14);
});

test('1 CARD TO WIN is not part of Rummy', () => {
  const state = scenario({ game: 'RUMMY', n: 2, hands: { p1: RICH } });
  assert.throws(() => act(state, { type: 'one-card-to-win', playerId: 'p1', active: true }), (e) => e.code === 'ONE_CARD_NOT_ELIGIBLE');
});
