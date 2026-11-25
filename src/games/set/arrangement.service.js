'use strict';

const { RANKS } = require('./constants');
const { jokerType } = require('./joker.service');

/**
 * Find the best way to arrange a hand into valid groups.
 *
 * Every group is made of ONE rank, so the search is small. For each rank with
 * natural cards we pick one of a few ways to use them (or leave them out):
 *
 *   all     one group with all n natural cards. It is a LIFE only if n is
 *           exactly 4 (lifeRule 'exactly') or at least 4 ('at-least').
 *   life4   (exactly-mode, n > 4) a LIFE of 4, and the other n-4 cards left out.
 *   life4+  (exactly-mode, n > 4) a LIFE of 4 plus a second ordinary group made
 *           of the other n-4 cards (3 or more, or 2 plus a wild card).
 *
 * A group of 1 or 2 natural cards needs wild cards to reach 3 cards (and at
 * least `minNaturalInJokerGroup` naturals). Wild cards are one shared budget;
 * spare ones attach to an existing group as extras.
 *
 * objective:
 *   'min-points'  fewest penalty points left over (default, used for scoring)
 *   'max-matched' most cards inside valid groups (used for 1 CARD TO WIN)
 * requireLife: only consider arrangements that contain a LIFE.
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

/** The ways the n natural cards of one rank can be used. */
function alternativesFor(cards, config) {
  const n = cards.length;
  const exact = config.lifeRule !== 'at-least';
  const lifeSize = config.lifeMinNatural;
  // wild cards needed for an ordinary group of m natural cards (null: not possible)
  const wildsFor = (m) => {
    if (m >= config.minGroupSize) return 0;
    return m >= config.minNaturalInJokerGroup ? config.minGroupSize - m : null;
  };
  const alts = [];
  const all = wildsFor(n);
  if (all !== null) {
    const life = exact ? n === lifeSize : n >= lifeSize;
    alts.push({ used: n, need: all, life, groups: [{ cards, need: all, isLife: life }] });
  }
  if (exact && n > lifeSize) {
    const lifeCards = cards.slice(0, lifeSize);
    const rest = cards.slice(lifeSize);
    alts.push({ used: lifeSize, need: 0, life: true, groups: [{ cards: lifeCards, need: 0, isLife: true }] });
    const restNeed = wildsFor(rest.length);
    if (restNeed !== null) {
      alts.push({
        used: n,
        need: restNeed,
        life: true,
        groups: [
          { cards: lifeCards, need: 0, isLife: true },
          { cards: rest, need: restNeed, isLife: exact ? rest.length === lifeSize : rest.length >= lifeSize },
        ],
      });
    }
  }
  return alts;
}

function solvePool(naturals, wilds, ctx, objective, requireLife) {
  const { config } = ctx;
  const byRank = new Map();
  for (const card of naturals) {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(card);
  }
  const ranks = RANKS.filter((r) => byRank.has(r)).map((rank) => {
    const cards = byRank.get(rank);
    return { rank, cards, value: config.cardValues[rank], alts: alternativesFor(cards, config) };
  });

  const wildValue = config.unmatchedJokerValue;
  const totalNaturalPoints = naturals.reduce((sum, c) => sum + config.cardValues[c.rank], 0);

  let best = null;
  const choice = new Array(ranks.length).fill(-1); // -1 = leave this rank out

  const evaluate = () => {
    let needed = 0;
    let matchedNaturals = 0;
    let matchedPoints = 0;
    let hasLife = false;
    let groupCount = 0;
    ranks.forEach((r, i) => {
      if (choice[i] < 0) return;
      const alt = r.alts[choice[i]];
      needed += alt.need;
      matchedNaturals += alt.used;
      matchedPoints += alt.used * r.value;
      hasLife = hasLife || alt.life;
      groupCount += alt.groups.length;
    });
    if (requireLife && !hasLife) return;
    const wildsMatched = groupCount > 0 ? wilds.length : 0; // spare wilds attach to a group
    const points = totalNaturalPoints - matchedPoints + (groupCount > 0 ? 0 : wilds.length * wildValue);
    const candidate = { hasLife, points, matchedCount: matchedNaturals + wildsMatched, choice: choice.slice() };
    if (!best || isBetter(candidate, best, objective)) best = candidate;
  };

  const walk = (i, wildsLeft) => {
    if (i === ranks.length) {
      evaluate();
      return;
    }
    choice[i] = -1;
    walk(i + 1, wildsLeft);
    ranks[i].alts.forEach((alt, a) => {
      if (alt.need > wildsLeft) return;
      choice[i] = a;
      walk(i + 1, wildsLeft - alt.need);
    });
    choice[i] = -1;
  };
  walk(0, wilds.length);
  if (!best) return null;

  // Build the groups for the winning choice.
  const groups = [];
  const unmatched = [];
  let wildIndex = 0;
  ranks.forEach((r, i) => {
    const alt = best.choice[i] >= 0 ? r.alts[best.choice[i]] : null;
    if (!alt) {
      unmatched.push(...r.cards);
      return;
    }
    for (const g of alt.groups) {
      const cards = g.cards.slice();
      for (let n = 0; n < g.need; n += 1) cards.push(wilds[wildIndex++]);
      groups.push({ rank: r.rank, cards, isLife: g.isLife });
    }
    unmatched.push(...r.cards.slice(alt.used));
  });

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
