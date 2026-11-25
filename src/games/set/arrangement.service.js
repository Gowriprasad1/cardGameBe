'use strict';

const { RANKS } = require('./constants');
const { jokerType } = require('./joker.service');

/**
 * Find the best way to arrange a hand into valid groups.
 *
 * Because every group is made of ONE rank, the search is small. For each rank
 * we either use ALL its natural cards in one group (more natural cards never
 * hurt) or none. A rank with only 1 or 2 natural cards needs wild cards to
 * reach 3 cards (and at least `minNaturalInJokerGroup` naturals). Wild cards
 * are a shared budget. Any wild card left over is attached to an existing group
 * as an extra card. At most 13 ranks, so we enumerate every subset.
 *
 * objective:
 *   'min-points'  fewest penalty points left over (default, used for scoring)
 *   'max-matched' most cards inside valid groups (used for 1 CARD TO WIN)
 * requireLife: when true, only arrangements with a LIFE group are considered.
 *
 * @param {import('./deck.service').Card[]} hand
 * @param {{config: object, openJokerRank: string}} ctx
 * @param {{objective?: 'min-points'|'max-matched', requireLife?: boolean}} [opts]
 * @returns {{feasible: false} | {
 *   feasible: true, hasLife: boolean, points: number, matchedCount: number,
 *   groups: {rank: string, cards: object[], isLife: boolean}[], unmatched: object[]
 * }}
 */
function findBestArrangement(hand, ctx, opts = {}) {
  const { objective = 'min-points', requireLife = true } = opts;
  const { config } = ctx;

  const printed = [];
  const open = [];
  const plain = [];
  for (const card of hand) {
    const type = jokerType(card, ctx);
    if (type === 'printed') printed.push(card);
    else if (type === 'open') open.push(card);
    else plain.push(card);
  }

  // When open-joker cards may also be natural in their own rank, try every split
  // between "used as wild" and "kept as natural". Otherwise they are all wild.
  const splits = config.openJokerNaturalInOwnRank
    ? Array.from({ length: open.length + 1 }, (_, k) => k)
    : [open.length];

  let best = null;
  for (const k of splits) {
    const wilds = printed.concat(open.slice(0, k));
    const naturals = plain.concat(open.slice(k));
    const candidate = solvePool(naturals, wilds, ctx, objective, requireLife);
    if (candidate && (!best || isBetter(candidate, best, objective))) best = candidate;
  }
  return best || { feasible: false };
}

function isBetter(a, b, objective) {
  if (objective === 'max-matched') {
    if (a.matchedCount !== b.matchedCount) return a.matchedCount > b.matchedCount;
    return a.points < b.points;
  }
  if (a.points !== b.points) return a.points < b.points;
  return a.matchedCount > b.matchedCount;
}

function solvePool(naturals, wilds, ctx, objective, requireLife) {
  const { config } = ctx;
  const byRank = new Map();
  for (const card of naturals) {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(card);
  }

  // Ranks that can form a group, with the wild cards each one needs.
  const options = [];
  for (const rank of RANKS) {
    const cards = byRank.get(rank);
    if (!cards) continue;
    const need = Math.max(0, config.minGroupSize - cards.length);
    if (need > 0 && (cards.length < config.minNaturalInJokerGroup || need > wilds.length)) continue;
    options.push({ rank, cards, need, value: config.cardValues[rank], life: cards.length >= config.lifeMinNatural });
  }

  const wildValue = config.unmatchedJokerValue;
  const totalNaturalPoints = naturals.reduce((sum, c) => sum + config.cardValues[c.rank], 0);

  let best = null;
  const total = 1 << options.length;
  for (let mask = 0; mask < total; mask += 1) {
    let needed = 0;
    let matchedNaturals = 0;
    let matchedPoints = 0;
    let hasLife = false;
    let groupCount = 0;
    for (let i = 0; i < options.length; i += 1) {
      if (!(mask & (1 << i))) continue;
      const o = options[i];
      needed += o.need;
      matchedNaturals += o.cards.length;
      matchedPoints += o.cards.length * o.value;
      hasLife = hasLife || o.life;
      groupCount += 1;
    }
    if (needed > wilds.length) continue;
    if (requireLife && !hasLife) continue;

    const wildsMatched = groupCount > 0 ? wilds.length : 0; // spare wilds attach to a group
    const points = totalNaturalPoints - matchedPoints + (groupCount > 0 ? 0 : wilds.length * wildValue);
    const candidate = { mask, hasLife, points, matchedCount: matchedNaturals + wildsMatched };
    if (!best || isBetter(candidate, best, objective)) best = candidate;
  }
  if (!best) return null;

  // Build the groups for the winning subset.
  const groups = [];
  let wildIndex = 0;
  const unmatched = [];
  options.forEach((o, i) => {
    if (best.mask & (1 << i)) {
      const cards = o.cards.slice();
      for (let n = 0; n < o.need; n += 1) cards.push(wilds[wildIndex++]);
      groups.push({ rank: o.rank, cards, isLife: o.life });
    } else {
      unmatched.push(...o.cards);
    }
  });
  // Ranks that could not form a group at all are unmatched too.
  const optionRanks = new Set(options.map((o) => o.rank));
  for (const [rank, cards] of byRank) if (!optionRanks.has(rank)) unmatched.push(...cards);

  const spare = wilds.slice(wildIndex);
  if (groups.length > 0) {
    const target = groups.find((g) => g.isLife) || groups[0];
    target.cards.push(...spare);
  } else {
    unmatched.push(...spare);
  }

  return {
    feasible: true,
    hasLife: best.hasLife,
    points: best.points,
    matchedCount: best.matchedCount,
    groups,
    unmatched,
  };
}

module.exports = { findBestArrangement };
