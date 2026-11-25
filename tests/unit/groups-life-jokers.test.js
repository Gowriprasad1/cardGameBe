'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGroup } = require('../../src/games/set/set-validation.service');
const { isLifeGroup, analyzeLife } = require('../../src/games/set/life-validation.service');
const { jokerType, canActAsWild, canBeNatural } = require('../../src/games/set/joker.service');
const { cards, ctx } = require('../helpers/cards');

const valid = (str, c = ctx()) => validateGroup(cards(str), c).valid;
const life = (str, c = ctx()) => isLifeGroup(cards(str), c);

// 7. Three-card group validation (RULE A)
test('a group is valid with 3 or more cards of the same rank', () => {
  assert.equal(valid('8H 8D 8C'), true);
  assert.equal(valid('9H 9D 9C'), true);
  assert.equal(valid('10H 10D 10C'), true);
  assert.equal(valid('8H 8D 8C 8S'), true);
  assert.equal(valid('8H 8D 8C 8S 8H/2'), true);
});

test('a group is invalid with fewer than 3 cards, or mixed ranks', () => {
  assert.equal(valid('5H 5D'), false);
  assert.equal(validateGroup(cards('5H 5D'), ctx()).reason, 'TOO_SMALL');
  assert.equal(valid('5H 5D 6C'), false);
  assert.equal(validateGroup(cards('5H 5D 6C'), ctx()).reason, 'MIXED_RANKS');
  assert.equal(valid('5H 5D 5C 6C'), false);
});

// 8. LIFE: exactly 4 natural identical-rank cards
test('LIFE is exactly 4 natural cards of one rank', () => {
  assert.equal(life('7H 7D 7C 7S'), true);
  assert.equal(life('9H 9D 9C'), false);
  assert.equal(analyzeLife(cards('7H 7D 7C 7S'), ctx()).naturalCount, 4);
});

test('five or more of a rank is a valid ordinary set but NOT a LIFE', () => {
  assert.equal(valid('8H 8D 8C 8S 8H/2'), true);
  assert.equal(life('8H 8D 8C 8S 8H/2'), false);
  assert.equal(life('8H 8D 8C 8S 8H/2 8D/2'), false);
});

test('rule option lifeRule "at-least" restores 4-or-more LIFE', () => {
  assert.equal(life('8H 8D 8C 8S 8H/2', ctx('A', { lifeRule: 'at-least' })), true);
  assert.throws(() => ctx('A', { lifeRule: 'sometimes' }), { code: 'INVALID_CONFIG' });
});

// 9. Joker not allowed in LIFE
test('a joker never completes LIFE: 7,7,7,Joker is not LIFE', () => {
  assert.equal(life('7H 7D 7C JK1'), false);
  assert.equal(validateGroup(cards('7H 7D 7C JK1'), ctx()).valid, true, 'but it is a valid normal group');
  assert.equal(life('7H 7D JK1 JK2'), false);
});

test('an open-joker card never completes LIFE either', () => {
  // open joker rank is K: the K is wild, so 7,7,7,K is not LIFE
  assert.equal(life('7H 7D 7C KH', ctx('K')), false);
  assert.equal(life('7H 7D 7C 7S', ctx('K')), true);
});

test('an extra joker sitting in a group that already has 4 natural cards is only filler', () => {
  const analysis = validateGroup(cards('7H 7D 7C 7S JK1'), ctx());
  assert.equal(analysis.valid, true);
  assert.equal(analysis.isLife, true);
  assert.equal(analysis.naturalCount, 4);
  assert.equal(analysis.wildCount, 1);
});

// 10. Joker substitution in normal groups
test('a joker completes a normal group: 5,5,Joker is valid', () => {
  assert.equal(valid('5H 5D JK1'), true);
  const a = validateGroup(cards('5H 5D JK1'), ctx());
  assert.equal(a.rank, '5');
  assert.equal(a.wildCount, 1);
  assert.equal(a.isLife, false);
});

test('a single natural card with two jokers is a valid set (5,Joker,Joker)', () => {
  assert.equal(valid('5H JK1 JK2'), true);
  assert.equal(validateGroup(cards('5H JK1 JK2'), ctx()).wildCount, 2);
});

test('jokers alone are not a group, and the stricter 2-natural rule is available as an option', () => {
  assert.equal(valid('JK1 JK2 JK1/2'), false);
  assert.equal(validateGroup(cards('JK1 JK2 JK1/2'), ctx()).reason, 'ALL_WILD');
  const strict = ctx('A', { minNaturalInJokerGroup: 2 });
  assert.equal(valid('5H JK1 JK2', strict), false);
  assert.equal(validateGroup(cards('5H JK1 JK2'), strict).reason, 'NOT_ENOUGH_NATURAL_CARDS');
});

// 11. Open joker validation
test('printed and open jokers are identified correctly', () => {
  const c = ctx('9');
  const [printed, open, normal] = cards('JK1 9H 5H');
  assert.equal(jokerType(printed, c), 'printed');
  assert.equal(jokerType(open, c), 'open');
  assert.equal(jokerType(normal, c), null);
  assert.equal(canActAsWild(open, c), true);
  assert.equal(canActAsWild(normal, c), false);
  assert.equal(canBeNatural(open, '9', c), false, 'open joker is never natural by default');
  assert.equal(canBeNatural(normal, '5', c), true);
  assert.equal(canBeNatural(printed, '5', c), false);
});

test('an open-joker rank card can replace a card in a normal group', () => {
  // open joker rank is 9, so the 9 of hearts is wild
  assert.equal(valid('5H 5D 9H', ctx('9')), true);
  assert.equal(valid('5H 5D 9H', ctx('A')), false, 'without the open joker a 9 is a stranger');
});

test('openJokerNaturalInOwnRank lets the open-joker rank form its own group', () => {
  const strict = ctx('9');
  const relaxed = ctx('9', { openJokerNaturalInOwnRank: true });
  assert.equal(valid('9H 9D 9C 9S', strict), false);
  assert.equal(valid('9H 9D 9C 9S', relaxed), true);
  assert.equal(life('9H 9D 9C 9S', relaxed), true);
});

// 12. Multiple jokers
test('multiple jokers can fill the same group', () => {
  assert.equal(valid('5H 5D JK1 JK2'), true);
  assert.equal(valid('5H 5D 9H JK1', ctx('9')), true, 'one printed + one open joker');
  assert.equal(valid('5H 5D 5C JK1 JK2'), true);
});
