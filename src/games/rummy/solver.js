'use strict';

const { describe, evaluateInfos } = require('./melds');

/**
 * Search for the best way to place a hand into melds.
 *
 * Every valid meld (any subset of 3+ cards that is a pure sequence, sequence or
 * set) is listed, then a memoised search picks disjoint melds. A meld may only
 * count toward the "two sequences" rule, so the search tracks whether a pure
 * sequence and how many sequences (0, 1, 2+) have been chosen.
 *
 * @param {import('../set/deck.service').Card[]} hand
 * @param {{config: object, openJokerRank: string}} ctx
 * @param {(card: object) => number} weight what covering a card is worth
 */
function searchMelds(hand, ctx, weight) {
  const n = hand.length;
  const infos = hand.map((c) => describe(c, ctx));
  const weights = hand.map(weight);

  const melds = [];
  const containing = Array.from({ length: n }, () => []);
  for (let mask = 7; mask < (1 << n); mask += 1) {
    const picked = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) picked.push(i);
    if (picked.length < 3) continue;
    const kind = evaluateInfos(picked.map((i) => infos[i]), ctx.config);
    if (!kind) continue;
    const meld = {
      mask, kind, indexes: picked, isSeq: kind !== 'set', isPure: kind === 'pure',
      weight: picked.reduce((sum, i) => sum + weights[i], 0),
    };
    melds.push(meld);
    containing[picked[0]].push(meld); // indexed by the lowest card it contains
  }

  // best total weight of disjoint melds over the cards in `rem`, given what was chosen so far
  const memo = new Map();
  const NONE = -1e9;
  const solve = (rem, pure, seqs) => {
    if (rem === 0) return { value: pure && seqs >= 2 ? 0 : NONE, choice: null };
    const key = rem * 8 + (pure ? 4 : 0) + seqs;
    const hit = memo.get(key);
    if (hit) return hit;
    const low = 31 - Math.clz32(rem & -rem);
    // leave the lowest card out of every meld
    let best = { value: solve(rem & ~(1 << low), pure, seqs).value, choice: null };
    for (const meld of containing[low]) {
      if ((meld.mask & rem) !== meld.mask) continue;
      const sub = solve(rem & ~meld.mask, pure || meld.isPure, Math.min(2, seqs + (meld.isSeq ? 1 : 0)));
      if (sub.value > NONE / 2 && sub.value + meld.weight > best.value) best = { value: sub.value + meld.weight, choice: meld };
    }
    memo.set(key, best);
    return best;
  };

  const full = (1 << n) - 1;
  const top = solve(full, false, 0);
  const chosen = [];
  if (top.value > NONE / 2) {
    let rem = full;
    let pure = false;
    let seqs = 0;
    while (rem !== 0) {
      const step = solve(rem, pure, seqs);
      const low = 31 - Math.clz32(rem & -rem);
      if (!step.choice) {
        rem &= ~(1 << low);
      } else {
        chosen.push(step.choice);
        rem &= ~step.choice.mask;
        pure = pure || step.choice.isPure;
        seqs = Math.min(2, seqs + (step.choice.isSeq ? 1 : 0));
      }
    }
  }
  const purePresent = melds.some((m) => m.isPure);
  const bestPure = melds.filter((m) => m.isPure).sort((a, b) => b.weight - a.weight)[0] || null;
  return {
    hand, melds, purePresent, bestPure,
    twoSequences: top.value > NONE / 2 ? { value: top.value, melds: chosen } : null,
  };
}

const toGroup = (hand, meld) => ({ cardIds: meld.indexes.map((i) => hand[i].id), kind: meld.kind });

/**
 * A complete winning arrangement of the hand (every card in a meld, at least two
 * sequences, one of them pure), or null.
 */
function findDeclaration(hand, ctx) {
  const found = searchMelds(hand, ctx, () => 1).twoSequences;
  if (!found || found.value !== hand.length) return null;
  return found.melds.map((m) => toGroup(hand, m));
}

/**
 * The arrangement that leaves the fewest points uncovered, with the Indian
 * Rummy counting rules:
 *  - no pure sequence: nothing is covered (all cards count)
 *  - a pure sequence but no second sequence: only the pure sequence is covered
 *  - a pure sequence and a second sequence: every meld is covered
 * @returns {{covered: number, groups: {cardIds: string[], kind: string}[], purePresent: boolean, mode: 'none'|'pure-only'|'full'}}
 */
function findBestCounting(hand, ctx, points) {
  const weight = (card) => points(card);
  const search = searchMelds(hand, ctx, weight);
  if (!search.purePresent) return { covered: 0, groups: [], purePresent: false, mode: 'none' };
  const full = search.twoSequences ? search.twoSequences.value : -1;
  const single = search.bestPure ? search.bestPure.weight : -1;
  if (full >= single && search.twoSequences) {
    return { covered: full, groups: search.twoSequences.melds.map((m) => toGroup(hand, m)), purePresent: true, mode: 'full' };
  }
  return { covered: Math.max(single, 0), groups: [toGroup(hand, search.bestPure)], purePresent: true, mode: 'pure-only' };
}

module.exports = { searchMelds, findDeclaration, findBestCounting };
