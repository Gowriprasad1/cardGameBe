'use strict';

const { cardPoints } = require('./melds');
const { findBestCounting } = require('./solver');
const { PENALTY_REASON } = require('../set/constants');

/**
 * Count of a player left holding `hand` when somebody else shows validly.
 * (Indian Rummy rules, always the best arrangement for the player.)
 *
 *  - no pure sequence anywhere: every card counts
 *  - a pure sequence but no second sequence: only the pure sequence is free
 *  - a pure sequence plus a second sequence: sequences AND sets are free
 *  Jokers and wild-joker cards count 0. Nobody counts more than maxRoundPenalty (80).
 */
function scoreHand(hand, ctx) {
  const { config } = ctx;
  const best = findBestCounting(hand, ctx, (card) => cardPoints(card, ctx));
  const total = hand.reduce((sum, c) => sum + cardPoints(c, ctx), 0);
  const covered = new Set(best.groups.flatMap((g) => g.cardIds));
  return {
    points: Math.min(total - best.covered, config.maxRoundPenalty),
    reason: best.purePresent ? PENALTY_REASON.UNMATCHED_CARDS : 'no_pure_sequence',
    hasLife: false,
    groups: best.groups.map((g) => ({ cardIds: g.cardIds, isLife: false, kind: g.kind })),
    unmatchedIds: hand.filter((c) => !covered.has(c.id)).map((c) => c.id),
  };
}

module.exports = { scoreHand };
