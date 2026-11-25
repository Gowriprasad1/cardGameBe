'use strict';

const { RANKS } = require('./constants');
const { findBestArrangement } = require('./arrangement.service');

/**
 * "1 CARD TO WIN" eligibility: the player is WAITING for one card.
 *
 * A 13-card hand qualifies when it cannot be declared yet, but there is a card
 * that, once drawn, lets the player discard one card and declare a valid hand
 * (a LIFE of exactly 4 natural cards, every other group of 3 or more).
 *
 * Examples:
 *  - 6,6,6  4,4,4  8,8,8  K,K  3,3   with 3 as the open joker: drawing any 6, 4 or 8
 *    makes a LIFE; K,K plus an open-joker 3 is a set; the spare 3 is discarded.
 *  - 4,4,4  5,5,5  6,6,6  7,7,7  9:  drawing a 4th 4, 5, 6 or 7 makes the LIFE and the 9 is discarded.
 *  - 7,7,7,7  8,8,8,8  9,9,9,9  K:  drawing a 7, 8 or 9 and discarding the K.
 *
 * A hand that is already complete is not "one card away" (it should declare).
 * Only the yes/no answer is ever shown to other players, never the cards.
 *
 * @param {import('./deck.service').Card[]} hand
 * @param {{config: object, openJokerRank: string}} ctx
 * @param {number} [deckCount] decks in play (2 players: 1, otherwise 2); limits which cards can still exist
 * @returns {{eligible: boolean, waitingFor: string[]}} waitingFor: ranks (or 'JOKER') that would complete the hand
 */
function checkOneCardToWin(hand, ctx, deckCount = 2) {
  const none = { eligible: false, waitingFor: [] };
  if (hand.length !== ctx.config.cardsPerPlayer) return none;

  const now = findBestArrangement(hand, ctx, { objective: 'max-matched', requireLife: true });
  if (now.feasible && now.matchedCount === hand.length) return none; // already a winning hand

  const perRank = {};
  let jokers = 0;
  for (const card of hand) {
    if (card.joker) jokers += 1;
    else perRank[card.rank] = (perRank[card.rank] || 0) + 1;
  }

  // Every card that could still be drawn. Suits do not matter (groups are by rank);
  // a rank is skipped once every copy of it is already in this hand.
  const candidates = RANKS
    .filter((rank) => (perRank[rank] || 0) < deckCount * 4)
    .map((rank) => ({ id: `WAIT-${rank}`, deck: 0, suit: 'H', rank, joker: false }));
  if (jokers < deckCount * 2) candidates.push({ id: 'WAIT-JOKER', deck: 0, suit: null, rank: null, joker: true });

  const waitingFor = [];
  for (const candidate of candidates) {
    if (winsAfterDiscard([...hand, candidate], ctx)) waitingFor.push(candidate.joker ? 'JOKER' : candidate.rank);
  }
  return { eligible: waitingFor.length > 0, waitingFor };
}

/** With 14 cards, is there one card to throw away that leaves a fully valid 13? */
function winsAfterDiscard(fourteen, ctx) {
  const best = findBestArrangement(fourteen, ctx, { objective: 'max-matched', requireLife: true });
  if (!best.feasible || best.matchedCount < fourteen.length - 1) return false;
  const tried = new Set();
  for (const card of fourteen) {
    const key = card.joker ? 'JOKER' : card.rank; // cards of one rank are interchangeable
    if (tried.has(key)) continue;
    tried.add(key);
    const rest = fourteen.filter((c) => c !== card);
    const arrangement = findBestArrangement(rest, ctx, { objective: 'max-matched', requireLife: true });
    if (arrangement.feasible && arrangement.matchedCount === rest.length) return true;
  }
  return false;
}

module.exports = { checkOneCardToWin };
