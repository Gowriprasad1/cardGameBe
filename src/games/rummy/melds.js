'use strict';

/**
 * Indian Rummy melds.
 *
 *  - PURE SEQUENCE: 3 or more consecutive cards of one suit, no joker at all
 *    (the wild-joker number may be used as its own natural card).
 *  - SEQUENCE (impure): consecutive cards of one suit where jokers fill gaps or ends.
 *  - SET: 3 or 4 cards of one number, all different suits (jokers may fill).
 *
 * Aces are low (A-2-3) or high (Q-K-A). K-A-2 does not wrap.
 *
 * Jokers: printed jokers are always wild. Every card of the face-up "cut joker"
 * number is a wild joker too, but it may also be used as its own natural card,
 * for example inside a pure sequence.
 */

const RANK_VALUE = {
  A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13,
};

const KIND_STRENGTH = { pure: 3, seq: 2, set: 1 };

/** Per-card facts used by the meld search. */
function describe(card, ctx) {
  const printed = Boolean(card.joker);
  const flex = !printed && Boolean(ctx.openJokerRank) && card.rank === ctx.openJokerRank;
  return {
    id: card.id,
    printed, // always wild
    flex, // wild, or its own natural card
    suit: card.suit,
    rank: card.rank,
    value: printed ? 0 : RANK_VALUE[card.rank],
  };
}

const distinct = (arr) => new Set(arr).size === arr.length;

/**
 * Classify a group given which cards are natural. Returns 'pure' | 'seq' | 'set' | null.
 * @param {{suit: string, rank: string, value: number}[]} naturals
 * @param {number} wilds number of jokers in the group
 */
function classify(naturals, wilds, config) {
  const n = naturals.length + wilds;
  if (naturals.length < config.minNaturalInMeld) return null;

  // sequence: one suit, distinct ranks that fit in a window of n consecutive ranks
  if (new Set(naturals.map((c) => c.suit)).size === 1) {
    const lowAce = naturals.map((c) => c.value);
    const options = [lowAce];
    if (naturals.some((c) => c.rank === 'A')) options.push(naturals.map((c) => (c.rank === 'A' ? 14 : c.value)));
    for (const ranks of options) {
      if (!distinct(ranks)) continue;
      const lo = Math.min(...ranks);
      const hi = Math.max(...ranks);
      const first = Math.max(1, hi - n + 1);
      const last = Math.min(lo, 14 - n + 1);
      if (first <= last) return wilds === 0 ? 'pure' : 'seq';
    }
  }

  // set: one number, different suits, at most maxSetSize cards
  if (n <= config.maxSetSize
    && new Set(naturals.map((c) => c.rank)).size === 1
    && distinct(naturals.map((c) => c.suit))) {
    return 'set';
  }
  return null;
}

/**
 * What is this group of cards? The strongest reading wins (pure > sequence > set),
 * which is also the best reading for the player.
 * @param {object[]} infos results of describe()
 * @returns {'pure'|'seq'|'set'|null}
 */
function evaluateInfos(infos, config) {
  const n = infos.length;
  if (n < 3) return null;

  const fixed = [];
  const flex = [];
  let wild = 0;
  for (const c of infos) {
    if (c.printed) wild += 1;
    else if (c.flex) flex.push(c);
    else fixed.push(c);
  }
  // quick reject: real cards that are neither one suit nor one number can never be a meld
  if (fixed.length >= 2) {
    const sameSuit = fixed.every((c) => c.suit === fixed[0].suit);
    const sameRank = fixed.every((c) => c.rank === fixed[0].rank);
    if (!sameSuit && !sameRank) return null;
  }

  let best = null;
  for (let mask = 0; mask < (1 << flex.length); mask += 1) {
    const naturals = fixed.slice();
    let wilds = wild;
    flex.forEach((c, i) => {
      if (mask & (1 << i)) naturals.push(c);
      else wilds += 1;
    });
    const kind = classify(naturals, wilds, config);
    if (kind && (!best || KIND_STRENGTH[kind] > KIND_STRENGTH[best])) best = kind;
  }
  return best;
}

/**
 * @param {import('../set/deck.service').Card[]} cards
 * @param {{config: object, openJokerRank: string}} ctx
 */
function evaluateMeld(cards, ctx) {
  return evaluateInfos(cards.map((c) => describe(c, ctx)), ctx.config);
}

/** Points of one card when it is left outside the melds. */
function cardPoints(card, ctx) {
  if (card.joker) return ctx.config.jokerValue;
  if (ctx.openJokerRank && card.rank === ctx.openJokerRank) return ctx.config.jokerValue;
  return ctx.config.cardValues[card.rank];
}

module.exports = { RANK_VALUE, KIND_STRENGTH, describe, evaluateInfos, evaluateMeld, cardPoints };
