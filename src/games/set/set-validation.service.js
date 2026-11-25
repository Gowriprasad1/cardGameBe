'use strict';

const { canActAsWild, canBeNatural } = require('./joker.service');
const { qualifiesAsLife } = require('./life-validation.service');

/**
 * @typedef {Object} GroupAnalysis
 * @property {boolean} valid
 * @property {string|null} rank          rank the group represents
 * @property {number} naturalCount
 * @property {number} wildCount          jokers / open-joker cards used as wild
 * @property {boolean} isLife            4+ natural cards of the rank
 * @property {string|null} reason        why it is invalid
 */

/**
 * Validate one normal group: at least 3 cards of one rank, where wild cards may
 * fill in as long as the group keeps at least `minNaturalInJokerGroup` (2)
 * natural cards. 5,5,Joker is valid; 5,Joker,Joker is not.
 *
 * @param {import('./deck.service').Card[]} cards
 * @param {{config: object, openJokerRank: string}} ctx
 * @returns {GroupAnalysis}
 */
function validateGroup(cards, ctx) {
  const { config } = ctx;
  const invalid = (reason, extra = {}) => ({
    valid: false, rank: null, naturalCount: 0, wildCount: 0, isLife: false, reason, ...extra,
  });

  if (cards.length < config.minGroupSize) return invalid('TOO_SMALL');

  const candidateRanks = new Set(
    cards.filter((c) => !c.joker && canBeNatural(c, c.rank, ctx)).map((c) => c.rank),
  );
  if (candidateRanks.size === 0) return invalid('ALL_WILD');

  let best = null;
  let sawWildOnlyMismatch = false;
  for (const rank of candidateRanks) {
    const naturals = cards.filter((c) => canBeNatural(c, rank, ctx));
    const rest = cards.filter((c) => !canBeNatural(c, rank, ctx));
    if (!rest.every((c) => canActAsWild(c, ctx))) continue; // another rank is mixed in
    sawWildOnlyMismatch = true;
    if (rest.length > 0 && naturals.length < config.minNaturalInJokerGroup) continue;
    const analysis = {
      valid: true,
      rank,
      naturalCount: naturals.length,
      wildCount: rest.length,
      isLife: qualifiesAsLife(naturals.length, config),
      reason: null,
    };
    if (!best || (analysis.isLife && !best.isLife) || analysis.naturalCount > best.naturalCount) best = analysis;
  }

  if (best) return best;
  return invalid(sawWildOnlyMismatch ? 'NOT_ENOUGH_NATURAL_CARDS' : 'MIXED_RANKS');
}

/** @returns {boolean} */
function isValidGroup(cards, ctx) {
  return validateGroup(cards, ctx).valid;
}

module.exports = { validateGroup, isValidGroup };
