'use strict';

const { jokerType } = require('./joker.service');

/**
 * Penalty points of one card that is NOT part of a valid group.
 * Jokers (printed, and open-joker-rank cards unless they are natural) are
 * worth config.unmatchedJokerValue (default 0).
 */
function cardPoints(card, ctx) {
  const type = jokerType(card, ctx);
  if (type === 'printed') return ctx.config.unmatchedJokerValue;
  if (type === 'open' && !ctx.config.openJokerNaturalInOwnRank) return ctx.config.unmatchedJokerValue;
  return ctx.config.cardValues[card.rank];
}

module.exports = { cardPoints };
