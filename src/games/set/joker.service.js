'use strict';

/**
 * Joker rules in one reusable place.
 *
 * ctx = { config, openJokerRank }
 *  - printed joker: the physical joker cards, always wild
 *  - open joker:    every non-joker card whose rank equals ctx.openJokerRank
 *                   (the rank revealed at the start of the round)
 *
 * Wild cards can complete NORMAL groups only. They never count toward LIFE.
 */

/** @returns {'printed'|'open'|null} */
function jokerType(card, ctx) {
  if (card.joker) return 'printed';
  if (ctx.openJokerRank && card.rank === ctx.openJokerRank) return 'open';
  return null;
}

/** Can this card stand in for any rank inside a normal group? */
function canActAsWild(card, ctx) {
  return jokerType(card, ctx) !== null;
}

/**
 * Can this card be a NATURAL card of `rank`?
 * Printed jokers never can. Open-joker-rank cards only can when
 * config.openJokerNaturalInOwnRank is true.
 */
function canBeNatural(card, rank, ctx) {
  if (card.joker || card.rank !== rank) return false;
  if (jokerType(card, ctx) === 'open') return ctx.config.openJokerNaturalInOwnRank === true;
  return true;
}

/** Number of cards that can act as wild in `cards`. */
function countWild(cards, ctx) {
  let n = 0;
  for (const card of cards) if (canActAsWild(card, ctx)) n += 1;
  return n;
}

module.exports = { jokerType, canActAsWild, canBeNatural, countWild };
