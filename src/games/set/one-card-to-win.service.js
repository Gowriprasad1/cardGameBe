'use strict';

const { findBestArrangement } = require('./arrangement.service');

/**
 * "1 CARD TO WIN" eligibility.
 *
 * A player qualifies when, of their 13 cards, exactly 12 can be arranged into
 * valid groups (at least one LIFE of 4+ natural cards, every other group 3+, no
 * joker counted toward LIFE) and exactly one card is left over. A hand that is
 * already completely valid is not "one card away", so it does not qualify.
 *
 * Only an eligibility flag is ever shared with other players, never the cards.
 *
 * @returns {{eligible: boolean, matchedCount: number, strayCardId: string|null}}
 */
function checkOneCardToWin(hand, ctx) {
  if (hand.length !== ctx.config.cardsPerPlayer) return { eligible: false, matchedCount: 0, strayCardId: null };
  const best = findBestArrangement(hand, ctx, { objective: 'max-matched', requireLife: true });
  if (!best.feasible) return { eligible: false, matchedCount: 0, strayCardId: null };
  const eligible = best.matchedCount === hand.length - 1 && best.unmatched.length === 1;
  return { eligible, matchedCount: best.matchedCount, strayCardId: eligible ? best.unmatched[0].id : null };
}

module.exports = { checkOneCardToWin };
