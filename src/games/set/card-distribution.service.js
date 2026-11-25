'use strict';

const { buildDecks, verifyCardSet } = require('./deck.service');
const { shuffle, secureRandomInt } = require('./shuffle.service');
const { gameError } = require('./errors');

/**
 * Shuffle, reveal the Open Joker, deal and set up the piles for one round.
 *
 * Pile convention: the TOP of both piles is the LAST array element.
 *
 *  - openJokerCard: a face-up non-joker card taken out of play. Its rank is the
 *    Open Joker rank for the round.
 *  - hands: cardsPerPlayer cards each
 *  - discardPile: starts with one face-up card
 *  - drawPile: everything left
 *
 * @param {{playerIds: string[], deckCount: number, config: object, rng?: Function}} args
 */
function dealRound({ playerIds, deckCount, config, rng = secureRandomInt }) {
  const perPlayer = config.cardsPerPlayer;
  const deck = shuffle(buildDecks(deckCount), rng);
  if (deck.length < playerIds.length * perPlayer + 2) {
    throw gameError('INVALID_PLAYER_COUNT', { reason: 'not enough cards for this many players' });
  }

  const openIndex = deck.findIndex((card) => !card.joker);
  const [openJokerCard] = deck.splice(openIndex, 1);

  const hands = {};
  for (const id of playerIds) hands[id] = deck.splice(0, perPlayer);

  const discardPile = deck.splice(0, 1);
  const drawPile = deck;

  verifyCardSet([openJokerCard, ...Object.values(hands).flat(), ...discardPile, ...drawPile], deckCount);

  return { openJokerCard, openJokerRank: openJokerCard.rank, hands, discardPile, drawPile };
}

module.exports = { dealRound };
