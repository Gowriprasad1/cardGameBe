'use strict';

const { canActAsWild, canBeNatural } = require('./joker.service');

/**
 * LIFE: a group of NATURAL cards of one rank. By default (lifeRule 'exactly')
 * it is EXACTLY 4 natural cards: 7,7,7,7 is a LIFE, but 7,7,7,7,7 is not (it can
 * still be an ordinary set). With lifeRule 'at-least' 4 or more qualify.
 * Jokers never count: 7,7,7,Joker is not LIFE. (A joker sitting in a group that
 * already has the 4 natural cards is only an extra card.)
 */

/** @param {number} naturalCount @param {{lifeMinNatural:number, lifeRule?:string}} config */
function qualifiesAsLife(naturalCount, config) {
  if (config.lifeRule === 'at-least') return naturalCount >= config.lifeMinNatural;
  return naturalCount === config.lifeMinNatural;
}

/**
 * Inspect one group of cards.
 * @param {import('./deck.service').Card[]} cards
 * @param {{config: object, openJokerRank: string}} ctx
 * @returns {{isLife: boolean, rank: string|null, naturalCount: number}}
 */
function analyzeLife(cards, ctx) {
  const candidates = new Set(cards.filter((c) => !c.joker).map((c) => c.rank));
  let best = { isLife: false, rank: null, naturalCount: 0 };
  for (const rank of candidates) {
    const naturals = cards.filter((c) => canBeNatural(c, rank, ctx));
    const everythingElseWild = cards.every((c) => canBeNatural(c, rank, ctx) || canActAsWild(c, ctx));
    if (!everythingElseWild) continue;
    if (naturals.length > best.naturalCount) {
      best = { isLife: qualifiesAsLife(naturals.length, ctx.config), rank, naturalCount: naturals.length };
    }
  }
  return best;
}

/** @returns {boolean} */
function isLifeGroup(cards, ctx) {
  return analyzeLife(cards, ctx).isLife;
}

module.exports = { qualifiesAsLife, analyzeLife, isLifeGroup };
