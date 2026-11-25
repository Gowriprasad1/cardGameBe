'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDeck, buildDecks, deckCountForPlayers, verifyCardSet } = require('../../src/games/set/deck.service');
const { shuffle } = require('../../src/games/set/shuffle.service');
const { dealRound } = require('../../src/games/set/card-distribution.service');
const { pickInitialDealer, nextDealer, firstToPlay } = require('../../src/games/set/dealer.service');
const { resolveConfig } = require('../../src/games/set/set.config');
const { seededRng } = require('../helpers/cards');

const config = resolveConfig();

// 1. Deck generation
test('a deck has 52 normal cards + 2 printed jokers, 13 ranks x 4 suits', () => {
  const deck = buildDeck(1);
  assert.equal(deck.length, 54);
  assert.equal(deck.filter((c) => c.joker).length, 2);
  const normal = deck.filter((c) => !c.joker);
  assert.equal(normal.length, 52);
  assert.equal(new Set(normal.map((c) => c.rank)).size, 13);
  assert.equal(new Set(normal.map((c) => c.suit)).size, 4);
  for (const suit of ['H', 'D', 'C', 'S']) assert.equal(normal.filter((c) => c.suit === suit).length, 13);
});

// 2. One-deck configuration
test('2 players use exactly one deck', () => {
  assert.equal(deckCountForPlayers(2), 1);
  assert.equal(buildDecks(1).length, 54);
});

// 3. Two-deck configuration, unique instance ids
test('3, 4 and 5 players use two decks with unique physical instance ids', () => {
  for (const n of [3, 4, 5]) assert.equal(deckCountForPlayers(n), 2);
  const cards = buildDecks(2);
  assert.equal(cards.length, 108);
  assert.equal(new Set(cards.map((c) => c.id)).size, 108);
  assert.equal(cards.filter((c) => c.joker).length, 4);
  // same face, different decks, different instance
  assert.notEqual(cards.find((c) => c.id === 'D1-H-7').id, cards.find((c) => c.id === 'D2-H-7').id);
});

test('player counts outside 2..5 are rejected', () => {
  for (const n of [0, 1, 6, 2.5]) assert.throws(() => deckCountForPlayers(n), { code: 'INVALID_PLAYER_COUNT' });
});

// 25. Duplicate / missing card prevention
test('verifyCardSet rejects duplicate, missing and foreign cards', () => {
  const cards = buildDecks(1);
  assert.equal(verifyCardSet(cards, 1), true);
  assert.throws(() => verifyCardSet([...cards, cards[0]], 1), { code: 'INTEGRITY_VIOLATION' });
  assert.throws(() => verifyCardSet(cards.slice(1), 1), { code: 'INTEGRITY_VIOLATION' });
  assert.throws(() => verifyCardSet([...cards.slice(1), { ...cards[1] }], 1), { code: 'INTEGRITY_VIOLATION' });
  assert.throws(() => verifyCardSet([...cards.slice(1), { id: 'D9-X-1' }], 1), { code: 'INTEGRITY_VIOLATION' });
});

// 4. Shuffling
test('shuffle keeps every card, does not mutate the input, and is deterministic for a seeded rng', () => {
  const deck = buildDecks(2);
  const before = deck.map((c) => c.id).join();
  const a = shuffle(deck, seededRng(5));
  const b = shuffle(deck, seededRng(5));
  assert.equal(deck.map((c) => c.id).join(), before, 'input untouched');
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.notEqual(a.map((c) => c.id).join(), before, 'order changed');
  assert.equal(verifyCardSet(a, 2), true);
});

test('secure shuffle is unbiased: all 6 orderings of 3 items appear about equally', () => {
  const counts = new Map();
  const runs = 6000;
  for (let i = 0; i < runs; i += 1) {
    const key = shuffle(['a', 'b', 'c']).join('');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 6);
  for (const n of counts.values()) assert.ok(n > 750 && n < 1250, `ordering count ${n} out of range`);
});

// 5 + 6. Distribution and the 13-card rule
for (const players of [2, 3, 4, 5]) {
  test(`dealing for ${players} players: 13 cards each, nothing missing or duplicated`, () => {
    const ids = Array.from({ length: players }, (_, i) => `p${i + 1}`);
    const deckCount = deckCountForPlayers(players);
    const deal = dealRound({ playerIds: ids, deckCount, config, rng: seededRng(players) });

    for (const id of ids) assert.equal(deal.hands[id].length, 13);
    assert.equal(deal.discardPile.length, 1);
    assert.equal(deal.openJokerCard.joker, false, 'open joker is a normal card');
    assert.equal(deal.openJokerRank, deal.openJokerCard.rank);

    const total = deckCount * 54;
    assert.equal(1 + players * 13 + 1 + deal.drawPile.length, total);
    const all = [deal.openJokerCard, ...Object.values(deal.hands).flat(), ...deal.discardPile, ...deal.drawPile];
    assert.equal(verifyCardSet(all, deckCount), true);
  });
}

// Dealer selection and rotation
test('initial dealer is picked by the rng among the seated players', () => {
  const seats = ['a', 'b', 'c', 'd'];
  assert.equal(pickInitialDealer(seats, () => 2), 'c');
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(pickInitialDealer(seats));
  assert.deepEqual([...seen].sort(), seats);
});

test('dealer rotates clockwise, skipping eliminated players; first turn is after the dealer', () => {
  const seats = ['a', 'b', 'c', 'd'];
  assert.equal(nextDealer(seats, 'a', seats), 'b');
  assert.equal(nextDealer(seats, 'd', seats), 'a');
  assert.equal(nextDealer(seats, 'a', ['a', 'c', 'd']), 'c');
  assert.equal(nextDealer(seats, 'b', ['a', 'c']), 'c', 'dealer may have just been eliminated');
  assert.equal(firstToPlay(seats, 'c', seats), 'd');
  assert.equal(firstToPlay(seats, 'd', ['b', 'd']), 'b');
});
