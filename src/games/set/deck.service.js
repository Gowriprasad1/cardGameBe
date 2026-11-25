'use strict';

const { RANKS, SUITS } = require('./constants');
const { GameError, gameError } = require('./errors');

/**
 * @typedef {Object} Card
 * @property {string} id      unique physical instance id, e.g. "D2-H-7" or "D1-JK-2"
 * @property {number} deck    1 or 2
 * @property {string|null} suit  H D C S, null for a printed joker
 * @property {string|null} rank  A,2..10,J,Q,K, null for a printed joker
 * @property {boolean} joker  true for a printed joker
 */

/** 2 players use one deck, 3 to 5 players use two. */
function deckCountForPlayers(playerCount) {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 5) {
    throw gameError('INVALID_PLAYER_COUNT');
  }
  return playerCount === 2 ? 1 : 2;
}

/** @returns {Card[]} the 54 cards of one deck */
function buildDeck(deckNo) {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({ id: `D${deckNo}-${suit}-${rank}`, deck: deckNo, suit, rank, joker: false });
    }
  }
  cards.push({ id: `D${deckNo}-JK-1`, deck: deckNo, suit: null, rank: null, joker: true });
  cards.push({ id: `D${deckNo}-JK-2`, deck: deckNo, suit: null, rank: null, joker: true });
  return cards;
}

/** @returns {Card[]} all cards for deckCount decks, every instance id unique */
function buildDecks(deckCount) {
  if (deckCount !== 1 && deckCount !== 2) throw new GameError('INVALID_CONFIG', 'deckCount must be 1 or 2');
  const cards = [];
  for (let d = 1; d <= deckCount; d += 1) cards.push(...buildDeck(d));
  return cards;
}

/**
 * Assert that `cards` is exactly the full physical card set: no card missing,
 * none duplicated, none foreign.
 * @param {Card[]} cards
 * @param {number} deckCount
 */
function verifyCardSet(cards, deckCount) {
  const expected = new Set(buildDecks(deckCount).map((c) => c.id));
  const seen = new Set();
  const duplicates = [];
  const foreign = [];
  for (const card of cards) {
    if (!expected.has(card.id)) foreign.push(card.id);
    if (seen.has(card.id)) duplicates.push(card.id);
    seen.add(card.id);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (duplicates.length || foreign.length || missing.length) {
    throw gameError('INTEGRITY_VIOLATION', { duplicates, foreign, missing });
  }
  return true;
}

module.exports = { deckCountForPlayers, buildDeck, buildDecks, verifyCardSet };
