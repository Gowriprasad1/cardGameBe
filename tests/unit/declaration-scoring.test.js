'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDeclaration } = require('../../src/games/set/declaration.service');
const { scoreHand, dropPenalty, invalidDeclarationPenalty } = require('../../src/games/set/scoring.service');
const { findBestArrangement } = require('../../src/games/set/arrangement.service');
const { checkOneCardToWin } = require('../../src/games/set/one-card-to-win.service');
const { resolveConfig } = require('../../src/games/set/set.config');
const {
  findNewlyEliminated, markEliminated, resolveGameEnd, eligibleIds,
} = require('../../src/games/set/elimination.service');
const { cards, groupIds, ctx } = require('../helpers/cards');

const declare = (hand, groups, c = ctx()) => validateDeclaration({ hand: cards(hand), groups: groupIds(groups), ctx: c });

const EX1 = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C';
const EX1_GROUPS = ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C'];
const EX2 = '5H 5D 5C 5S 7H 7D 7C 7S 7H/2 6H 6D 6C 6S';
const EX2_GROUPS = ['5H 5D 5C 5S', '7H 7D 7C 7S 7H/2', '6H 6D 6C 6S'];
const EX3 = '5H 5D 5C 5S 7H 7D 7C 8H 8D 8C 9H 9D 9C';
const EX3_GROUPS = ['5H 5D 5C 5S', '7H 7D 7C', '8H 8D 8C', '9H 9D 9C'];
const EX4 = '5H 5D 5C 7H 7D 7C 8H 8D 8C 9H 9D 9C 9S';
const EX4_GROUPS = ['5H 5D 5C', '7H 7D 7C', '8H 8D 8C', '9H 9D 9C 9S'];

// 13. Valid declaration
test('the four example hands from the rules are valid declarations', () => {
  for (const [hand, groups] of [[EX1, EX1_GROUPS], [EX2, EX2_GROUPS], [EX3, EX3_GROUPS], [EX4, EX4_GROUPS]]) {
    const result = declare(hand, groups);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  }
});

test('a hand with jokers in normal groups and a natural LIFE is valid', () => {
  const hand = '7H 7D 7C 7S 8H 8D JK1 9H 9D JK2 10H 10D 10C';
  const result = declare(hand, ['7H 7D 7C 7S', '8H 8D JK1', '9H 9D JK2', '10H 10D 10C']);
  assert.equal(result.valid, true);
});

// 14. Invalid declarations
const codes = (r) => r.errors.map((e) => e.code);

test('declaration needs exactly 13 cards', () => {
  const r = validateDeclaration({ hand: cards(EX1).slice(0, 12), groups: groupIds(EX1_GROUPS), ctx: ctx() });
  assert.equal(r.valid, false);
  assert.deepEqual(codes(r), ['WRONG_CARD_COUNT']);
});

test('declaration without LIFE is invalid even when every group is valid', () => {
  // 3+3+3+4 where the 4-card group uses a joker: only 3 natural cards
  const hand = '5H 5D 5C 6H 6D 6C 8H 8D 8C 9H 9D 9C JK1';
  const r = declare(hand, ['5H 5D 5C', '6H 6D 6C', '8H 8D 8C', '9H 9D 9C JK1']);
  assert.equal(r.valid, false);
  assert.deepEqual(codes(r), ['NO_LIFE']);
});

test('a joker cannot complete LIFE (7,7,7,Joker)', () => {
  const hand = '7H 7D 7C JK1 8H 8D 8C 9H 9D 9C 10H 10D 10C';
  const r = declare(hand, ['7H 7D 7C JK1', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('NO_LIFE'));
});

test('incomplete groups are rejected', () => {
  const hand = '7H 7D 7C 7S 8H 8D 9H 9D 9C 10H 10D 10C JK1'; // 8,8 and a leftover joker
  const r = declare(hand, ['7H 7D 7C 7S', '8H 8D', '9H 9D 9C', '10H 10D 10C JK1']);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_GROUP'));
});

test('every card must be placed: missing cards are rejected', () => {
  const r = declare(EX1, ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C']);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MISSING_CARDS'));
});

test('a card cannot be used twice, and a joker cannot sit in two groups', () => {
  const hand = '5H 5D 6H 6D 7H 7D 7C 7S 8H 8D 8C JK1 JK2';
  const r = declare(hand, ['5H 5D JK1', '6H 6D JK1', '7H 7D 7C 7S', '8H 8D 8C JK2']);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('DUPLICATE_CARD'));
});

test('cards that are not in the hand are rejected', () => {
  const r = declare(EX1, ['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C', 'KH KD KC']);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('UNKNOWN_CARD'));
});

test('two jokers used separately in two different groups is valid', () => {
  const hand = '7H 7D 7C 7S 8H 8D JK1 9H 9D JK2 10H 10D 10C';
  const r = declare(hand, ['7H 7D 7C 7S', '8H 8D JK1', '9H 9D JK2', '10H 10D 10C']);
  assert.equal(r.valid, true);
});

// 15 + 16 + 17. Penalties
test('invalid declaration penalty is exactly 40 and cannot be configured away', () => {
  assert.equal(invalidDeclarationPenalty(resolveConfig()), 40);
  assert.throws(() => resolveConfig({ invalidDeclarationPenalty: 10 }), { code: 'INVALID_CONFIG' });
});

test('first drop costs 20 points, middle drop 40', () => {
  const config = resolveConfig();
  assert.deepEqual(dropPenalty(0, config), { type: 'first', penalty: 20, reason: 'first_drop' });
  assert.deepEqual(dropPenalty(1, config), { type: 'middle', penalty: 40, reason: 'middle_drop' });
  assert.deepEqual(dropPenalty(7, config), { type: 'middle', penalty: 40, reason: 'middle_drop' });
});

// 18 + 19. Unmatched-card scoring
test('only unmatched cards count: 7777 888 999 + 10,10 + K -> 30 points', () => {
  const hand = cards('7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D KH');
  const score = scoreHand(hand, ctx('A'));
  assert.equal(score.hasLife, true);
  assert.equal(score.points, 30); // 10 + 10 + K(10)
  assert.deepEqual(score.unmatchedIds.sort(), ['D1-D-10', 'D1-H-10', 'D1-H-K']);
});

test('cards inside valid groups are never counted', () => {
  const score = scoreHand(cards(EX1), ctx('A'));
  assert.equal(score.points, 0);
  assert.deepEqual(score.unmatchedIds, []);
});

test('validly used jokers are worth 0 and unmatched jokers are 0 by default', () => {
  const hand = cards('4H 4D 4C 4S 9H 9D JK1 2H 3D 6C 7H KC JK2');
  const score = scoreHand(hand, ctx('A'));
  // LIFE 4444, 9,9,JK1 as a group, JK2 attached as filler. Unmatched: 2,3,6,7,K = 28
  assert.equal(score.points, 28);
});

test('the scorer picks the grouping with the fewest points left (joker goes to the high pair)', () => {
  const hand = cards('4H 4D 4C 4S KH KD 2H 2D JK1 9H 3C 6D 5C');
  const score = scoreHand(hand, ctx('A'));
  // joker completes K,K (saves 20) rather than 2,2 (saves 4): left = 2+2+9+3+6+5 = 27
  assert.equal(score.points, 27);
  assert.ok(!score.unmatchedIds.includes('D1-H-K'));
});

test('a hand with no possible LIFE: the optional all-cards policy counts every non-joker card', () => {
  const hand = cards('5H 5D 5C 6H 6D 6C 8H 8D 8C 9H 9D 9C JK1');
  const score = scoreHand(hand, ctx('A', { noLifeHandPolicy: 'all-cards' }));
  assert.equal(score.hasLife, false);
  assert.equal(score.reason, 'no_life_hand');
  assert.equal(score.points, 15 + 18 + 24 + 27);
});

test('no LIFE: valid sets are not counted, only the cards outside them (default rule)', () => {
  const score = scoreHand(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C 9H 9D 9C 8H'), ctx('A'));
  assert.equal(score.hasLife, false);
  assert.equal(score.reason, 'no_life_hand');
  assert.equal(score.points, 8, 'four valid sets, only the 8 is counted');
  assert.deepEqual(score.unmatchedIds, ['D1-H-8']);
});

test('no LIFE: jokers cannot be used, so a leftover joker counts 2', () => {
  const score = scoreHand(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C 9H 9D 9C JK1'), ctx('A'));
  assert.equal(score.points, 2);
  assert.deepEqual(score.unmatchedIds, ['D1-JK-1']);
  // a card of the open-joker number is a joker too; three or more jokers are a set of their own
  const four = scoreHand(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C QH QD JK1 JK2'), ctx('Q'));
  assert.equal(four.points, 0, 'JK1, JK2 and the two open-joker queens are four jokers: a set, 0 points');
  assert.deepEqual(four.unmatchedIds, []);
  assert.ok(four.groups.some((g) => g.cardIds.length === 4 && g.rank === null), 'shown as a joker set');
});

test('no LIFE: three jokers count 0 even when kept apart; only loose natural cards count', () => {
  const score = scoreHand(cards('4H 4D 4C 5H 5D 5C 6H 6D 6C 8S JK1 JK2 QH'), ctx('Q'));
  assert.equal(score.hasLife, false);
  assert.equal(score.points, 8, 'three sets + a joker set (2 printed, 1 open) + the 8: only the 8 counts');
  assert.deepEqual(score.unmatchedIds, ['D1-S-8']);
});

test('no LIFE with loose cards: only the loose cards count, the jokers count 0', () => {
  // three sets + 5,5 + two jokers, and no four of a kind anywhere: 5 + 5 = 10
  const score = scoreHand(cards('2H 2D 2C 4H 4D 4C 6H 6D 6C 5H 5D JK1 JK2'), ctx('A'));
  assert.equal(score.hasLife, false);
  assert.equal(score.points, 10);
  assert.deepEqual(score.unmatchedIds.sort(), ['D1-D-5', 'D1-H-5']);
});

test('five or six of one number still contain a LIFE: the extras join another set (with jokers)', () => {
  const six = scoreHand(cards('2H 2D 2C 4H 4D 4C 5H 5D 5C 5H/2 5D/2 5C/2 JK1'), ctx('K'));
  assert.equal(six.hasLife, true);
  assert.equal(six.points, 0, '5555 is the LIFE and 5,5 + joker is a set');
  const five = scoreHand(cards('2H 2D 2C 4H 4D 4C 5H 5D 5C 5H/2 5D/2 JK1 JK2'), ctx('K'));
  assert.equal(five.points, 0, '5555 is the LIFE and 5 + two jokers is a set');
});

test('with a LIFE, jokers work: one natural card plus two jokers is a valid set', () => {
  const hand = cards('3H 3D 3C 3S 8H 8D 8C JK1 JK2 2H KH JH QH');
  const score = scoreHand(hand, ctx('A'));
  assert.equal(score.hasLife, true);
  assert.equal(score.points, 22, 'K + two jokers is a set; 2, J and Q are counted');
  assert.deepEqual(score.unmatchedIds.sort(), ['D1-H-2', 'D1-H-J', 'D1-H-Q']);
});

test('with a LIFE the jokers go with the highest single card', () => {
  const score = scoreHand(cards('3H 3D 3C 3S 8H 8D 8C JK1 JK2 2H 5H JH KH'), ctx('A'));
  assert.equal(score.points, 17, 'jokers join the K; 2 + 5 + J are counted');
});

test('maxRoundPenalty caps a round penalty when configured', () => {
  const hand = cards('2H 3D 4C 5S 6H 7D 8C 9S 10H JD QC KS AH');
  assert.ok(scoreHand(hand, ctx('A')).points > 80);
  assert.equal(scoreHand(hand, ctx('A', { maxRoundPenalty: 80 })).points, 80);
});

test('arrangement solver: valid 13-card hands match every card', () => {
  const best = findBestArrangement(cards(EX1), ctx('A'), { objective: 'max-matched' });
  assert.equal(best.feasible, true);
  assert.equal(best.matchedCount, 13);
  assert.equal(best.hasLife, true);
});

// 20 + 21. Elimination
const mkPlayers = (scores) => {
  const players = {};
  for (const [id, score] of Object.entries(scores)) players[id] = { id, score, status: 'active' };
  return players;
};

test('185 + 20 = 205 eliminates the player (>= 201, not exactly 201)', () => {
  const players = mkPlayers({ a: 185, b: 100, c: 0 });
  players.a.score += 20;
  assert.deepEqual(findNewlyEliminated(players, ['a', 'b', 'c'], 201), ['a']);
});

test('exactly 201 eliminates, 200 does not', () => {
  const players = mkPlayers({ a: 201, b: 200, c: 0 });
  assert.deepEqual(findNewlyEliminated(players, ['a', 'b', 'c'], 201), ['a']);
});

test('several players can be eliminated in the same round; history is preserved', () => {
  const players = mkPlayers({ a: 230, b: 205, c: 150, d: 10 });
  const seats = ['a', 'b', 'c', 'd'];
  const out = findNewlyEliminated(players, seats, 201);
  assert.deepEqual(out, ['a', 'b']);
  markEliminated(players, out, 4);
  assert.equal(players.a.status, 'eliminated');
  assert.equal(players.a.score, 230, 'score history kept');
  assert.equal(players.a.eliminatedInRound, 4);
  assert.deepEqual(eligibleIds(players, seats), ['c', 'd']);
  assert.deepEqual(resolveGameEnd({ players, seatOrder: seats, newlyEliminated: out }), { finished: false, winnerId: null });
});

test('the game ends when exactly one eligible player remains', () => {
  const players = mkPlayers({ a: 230, b: 205, c: 150 });
  const seats = ['a', 'b', 'c'];
  const out = findNewlyEliminated(players, seats, 201);
  markEliminated(players, out, 6);
  assert.deepEqual(resolveGameEnd({ players, seatOrder: seats, newlyEliminated: out }), { finished: true, winnerId: 'c' });
});

test('if everybody is out in one round the lowest cumulative score wins', () => {
  const players = mkPlayers({ a: 230, b: 205, c: 260 });
  const seats = ['a', 'b', 'c'];
  const out = findNewlyEliminated(players, seats, 201);
  markEliminated(players, out, 9);
  assert.deepEqual(resolveGameEnd({ players, seatOrder: seats, newlyEliminated: out }), { finished: true, winnerId: 'b' });
});

// 22. One card to win
test('1 CARD TO WIN: 12 cards in valid groups with a natural LIFE and one stray card', () => {
  const r = checkOneCardToWin(cards('7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 9C 9S KH'), ctx('A'));
  assert.equal(r.eligible, true);
  for (const rank of ['7', '8', '9', 'JOKER']) assert.ok(r.waitingFor.includes(rank), `waiting for ${rank}`);
  assert.ok(!r.waitingFor.includes('K'), 'a second K only makes a pair');
});

test('1 CARD TO WIN: a joker may fill a normal group but the stray card is still alone', () => {
  const r = checkOneCardToWin(cards('7H 7D 7C 7S 8H 8D 8C 8S 9H 9D JK1 JK2 KH'), ctx('A'));
  assert.equal(r.eligible, true);
});

test('1 CARD TO WIN: jokers help the sets, but the LIFE still needs a real fourth natural card', () => {
  const r = checkOneCardToWin(cards('7H 7D 7C JK1 8H 8D 8C JK2 9H 9D 9C QH KH'), ctx(), 2);
  assert.equal(r.eligible, true);
  for (const rank of ['7', '8', '9']) assert.ok(r.waitingFor.includes(rank), `waiting for ${rank}`);
  assert.ok(!r.waitingFor.includes('JOKER'), 'a joker can never be the 4th card of a LIFE');
});

test('1 CARD TO WIN: not eligible when the hand is already completely valid', () => {
  assert.equal(checkOneCardToWin(cards(EX1), ctx('A')).eligible, false);
});

test('1 CARD TO WIN: not eligible with two or more unmatched cards', () => {
  const r = checkOneCardToWin(cards('7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 2C QS KH'), ctx('A'));
  assert.equal(r.eligible, false);
});

test('1 CARD TO WIN: only evaluated on a 13 card hand', () => {
  const r = checkOneCardToWin(cards('7H 7D 7C 7S 8H 8D 8C 8S 9H 9D 9C 9S KH QH'), ctx('A'));
  assert.equal(r.eligible, false);
});

test('config validation rejects unknown keys and unsupported values', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), { code: 'INVALID_CONFIG' });
  assert.throws(() => resolveConfig({ invalidDeclarationPolicy: 'whatever' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => resolveConfig({ cardsPerPlayer: 10 }), { code: 'INVALID_CONFIG' });
  assert.equal(resolveConfig({ eliminationThreshold: 101 }).eliminationThreshold, 101);
});

test('a LIFE, two sets and three jokers (any mix) kept as their own set is a valid declaration', () => {
  for (const [jokers, open] of [['JK1 JK2 JK1/2', 'A'], ['JK1 9H 9D', '9'], ['JK1 JK2 9C', '9']]) {
    const hand = `3H 3D 3C 3S 5H 5D 5C 7H 7D 7C ${jokers}`;
    const r = declare(hand, ['3H 3D 3C 3S', '5H 5D 5C', '7H 7D 7C', jokers], ctx(open));
    assert.equal(r.valid, true, `${jokers}: ${JSON.stringify(r.errors)}`);
    // the computer player finds the same layout on its own
    const best = scoreHand(cards(hand), ctx(open));
    assert.equal(best.points, 0);
    assert.ok(best.groups.some((g) => g.rank === null && g.cardIds.length === 3), 'the jokers are their own set');
  }
});
