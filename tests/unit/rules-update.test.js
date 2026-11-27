'use strict';

/**
 * Rules clarified by the product owner (see docs/02-game-rules.md):
 *  1. A LIFE is exactly 4 natural cards of one rank.
 *  2. 1 CARD TO WIN: the player is waiting for a card that completes the hand.
 *  3. A printed joker on the open pile cannot be picked up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDeclaration } = require('../../src/games/set/declaration.service');
const { scoreHand } = require('../../src/games/set/scoring.service');
const { findBestArrangement } = require('../../src/games/set/arrangement.service');
const { checkOneCardToWin } = require('../../src/games/set/one-card-to-win.service');
const { viewFor } = require('../../src/games/set/view');
const {
  cards, groupIds, ctx, scenario, act, setDiscardTop, setDrawTop,
} = require('../helpers/cards');

const declare = (hand, groups, c = ctx()) => validateDeclaration({ hand: cards(hand), groups: groupIds(groups), ctx: c });
const codes = (r) => r.errors.map((e) => e.code);

// ---------------------------------------------------------------------------
// Rule 1: LIFE is exactly four
// ---------------------------------------------------------------------------

const P1 = '9H 9D 9C 9S 9H/2 6H 6D 6C 2H 2D 2C 2S 2H/2'; // five 9s, three 6s, five 2s

test('five 9s + three 6s + five 2s can NOT be declared (no group of exactly four to arrange)', () => {
  // all five 9s together is not a LIFE
  assert.deepEqual(codes(declare(P1, ['9H 9D 9C 9S 9H/2', '6H 6D 6C', '2H 2D 2C 2S 2H/2'])), ['NO_LIFE']);
  // four 9s as the LIFE leaves a single 9 that is in no valid group
  const r = declare(P1, ['9H 9D 9C 9S', '9H/2', '6H 6D 6C', '2H 2D 2C 2S 2H/2']);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_GROUP'));
});

test('the same hand scores only its leftover card (best arrangement for the player)', () => {
  const score = scoreHand(cards(P1), ctx());
  assert.equal(score.hasLife, true);
  // LIFE of four 2s, five 9s as an ordinary set, three 6s: only one 2 is left over
  assert.equal(score.points, 2);
  assert.equal(score.unmatchedIds.length, 1);
});

test('a group of five is fine as an ordinary set when another LIFE exists', () => {
  const hand = '5H 5D 5C 5S 7H 7D 7C 7S 7H/2 6H 6D 6C 6S'; // 5555 life, 77777 set, 6666
  assert.equal(declare(hand, ['5H 5D 5C 5S', '7H 7D 7C 7S 7H/2', '6H 6D 6C 6S']).valid, true);
  // and a hand whose only candidate is a group of five has no LIFE
  assert.deepEqual(codes(declare('7H 7D 7C 7S 7H/2 6H 6D 6C 8H 8D 8C 9H 9D', ['7H 7D 7C 7S 7H/2', '6H 6D 6C', '8H 8D 8C', '9H 9D'])).includes('NO_LIFE'), true);
});

test('with two decks eight of a rank can be a LIFE of four plus a set of four', () => {
  const hand = '7H 7D 7C 7S 7H/2 7D/2 7C/2 7S/2 9H 9D 9C JK1 JK2'.split(' ');
  const c = ctx();
  const arrangement = findBestArrangement(cards(hand.join(' ')), c, { objective: 'max-matched' });
  assert.equal(arrangement.feasible, true);
  assert.equal(arrangement.matchedCount, 13);
  assert.equal(arrangement.groups.filter((g) => g.rank === '7').length, 2);
  assert.ok(arrangement.groups.filter((g) => g.rank === '7').every((g) => g.isLife));
});

// ---------------------------------------------------------------------------
// Rule 2: 1 CARD TO WIN = waiting for a card
// ---------------------------------------------------------------------------

test('example B: 666 444 888 KK + two open-joker 3s is waiting for a 6, 4 or 8', () => {
  const r = checkOneCardToWin(cards('6H 6D 6C 4H 4D 4C 8H 8D 8C KH KD 3H 3D'), ctx('3'), 2);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.waitingFor, ['4', '6', '8']);
});

test('example C: 444 555 666 777 + a lone 9 is waiting for a fourth 4, 5, 6 or 7', () => {
  const r = checkOneCardToWin(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C 7H 7D 7C 9H'), ctx(), 2);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.waitingFor, ['4', '5', '6', '7']);
});

test('the five 9s / three 6s / five 2s hand is waiting too (a 6, a 9, a 2, or a joker)', () => {
  const r = checkOneCardToWin(cards(P1), ctx('A'), 2);
  assert.equal(r.eligible, true);
  for (const rank of ['6', '9', '2', 'JOKER']) assert.ok(r.waitingFor.includes(rank), rank);
});

test('not eligible: nothing can complete the hand with one card', () => {
  // three sets and four unrelated cards
  assert.equal(checkOneCardToWin(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C 8H 10D QC KS'), ctx(), 2).eligible, false);
  // only pairs: no single card can turn this into sets and a LIFE
  assert.equal(checkOneCardToWin(cards('2H 2D 3H 3D 4H 4D 5H 5D 6H 6D 7H 7D 9C'), ctx(), 2).eligible, false);
});

test('not eligible when the hand is already complete (declare instead)', () => {
  assert.equal(checkOneCardToWin(cards('7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C'), ctx(), 2).eligible, false);
});

test('only evaluated with 13 cards', () => {
  assert.equal(checkOneCardToWin(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C 7H 7D 7C 9H QH'), ctx(), 2).eligible, false);
});

test('the number of decks decides which cards can still be drawn', () => {
  const hand = cards('4H 4D 4C 4S 5H 5D 5C 5S 6H 6D 6C 6S KH');
  // two decks: a fifth 4, 5 or 6 still exists, throw the K away
  const twoDecks = checkOneCardToWin(hand, ctx(), 2);
  for (const rank of ['4', '5', '6']) assert.ok(twoDecks.waitingFor.includes(rank), rank);
  // one deck: all four 4s, 5s and 6s are already in this hand, so only a joker-type card can still arrive
  const oneDeck = checkOneCardToWin(hand, ctx(), 1);
  assert.equal(oneDeck.eligible, true);
  assert.deepEqual(oneDeck.waitingFor, ['A', 'JOKER']);
});

test('the server tells the client when the button may be used', () => {
  const state = scenario({ n: 3, openJoker: '3', hands: { p1: '6H 6D 6C 4H 4D 4C 8H 8D 8C KH KD 3H 3D', p2: '2H 5H 7H 9H 10H JH QH 2D 5D 7D 9D 10D JD' } });
  assert.equal(viewFor(state, 'p1').me.oneCardEligible, true);
  assert.equal(viewFor(state, 'p2').me.oneCardEligible, false);
  const { state: s } = act(state, { type: 'one-card-to-win', playerId: 'p1', active: true });
  assert.equal(s.round.oneCardToWin.p1, true);
});

// ---------------------------------------------------------------------------
// Rule 3: a printed joker on the open pile cannot be taken
// ---------------------------------------------------------------------------

test('a printed joker a player threw on the open pile cannot be picked up; the closed pile still works', () => {
  const state = scenario({ n: 2, openJoker: '5' });
  const p = state.round.currentPlayerId;
  setDiscardTop(state, 'JK1', { thrownBy: state.seatOrder.find((id) => id !== p) });
  assert.equal(viewFor(state, p).round.discardPickable, false);
  assert.throws(() => act(state, { type: 'draw', playerId: p, source: 'discard' }), (e) => e.code === 'JOKER_NOT_PICKABLE');
  const { state: s } = act(state, { type: 'draw', playerId: p, source: 'draw' });
  assert.equal(s.round.hands[p].length, 14);
  assert.equal(s.round.discardPile.at(-1).id, 'D1-JK-1', 'the joker stays where it was');
});

test('a printed joker turned face up at the deal CAN be taken by the first player', () => {
  const state = scenario({ n: 3, openJoker: '5' });
  const p = state.round.currentPlayerId;
  setDiscardTop(state, 'JK1'); // the first open card of the round, nobody threw it
  assert.equal(viewFor(state, p).round.discardPickable, true);
  const { state: s } = act(state, { type: 'draw', playerId: p, source: 'discard' });
  assert.ok(s.round.hands[p].some((c) => c.id === 'D1-JK-1'));
});

test('a dealt printed joker left on the pile is still takeable until somebody throws a card on it', () => {
  const state = scenario({ n: 3, openJoker: '5' });
  const p = state.round.currentPlayerId;
  setDiscardTop(state, 'JK1');
  setDrawTop(state, '2S');
  let s = act(state, { type: 'draw', playerId: p, source: 'draw' }).state;
  // the first player throws the drawn card on top: the joker is now buried
  s = act(s, { type: 'discard', playerId: p, cardId: 'D1-S-2' }).state;
  assert.equal(s.round.discardPile.at(-1).id, 'D1-S-2');
  assert.equal(viewFor(s, s.round.currentPlayerId).round.discardPickable, true);
});

test('a card of the open-joker number CAN be picked up from the open pile', () => {
  const state = scenario({ n: 2, openJoker: '5' });
  const p = state.round.currentPlayerId;
  setDiscardTop(state, '5D');
  assert.equal(viewFor(state, p).round.discardPickable, true);
  const { state: s } = act(state, { type: 'draw', playerId: p, source: 'discard' });
  assert.ok(s.round.hands[p].some((c) => c.id === 'D1-D-5'));
});

test('a joker thrown away on purpose lands on the open pile and then blocks it for the next player', () => {
  const state = scenario({ n: 2, openJoker: '5', hands: { p1: '2H 3H 4H 6H 7H 8H 9H 10H JH QH KH 2D JK1', p2: '3D 4D 5S 6D 7D 8D 9D 10D JD QD KD 2C 3C' } });
  state.round.currentPlayerId = 'p1';
  setDrawTop(state, '2S');
  let s = act(state, { type: 'draw', playerId: 'p1', source: 'draw' }).state;
  s = act(s, { type: 'discard', playerId: 'p1', cardId: 'D1-JK-1' }).state;
  assert.equal(s.round.currentPlayerId, 'p2');
  assert.throws(() => act(s, { type: 'draw', playerId: 'p2', source: 'discard' }), (e) => e.code === 'JOKER_NOT_PICKABLE');
  assert.equal(viewFor(s, 'p2').round.discardPickable, false);
});
