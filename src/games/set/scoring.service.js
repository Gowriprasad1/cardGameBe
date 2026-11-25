'use strict';

const { findBestArrangement } = require('./arrangement.service');
const { cardPoints } = require('./card-values');
const { PENALTY_REASON } = require('./constants');

/**
 * All scoring happens here, on the backend. Nothing the client sends is ever
 * used to compute points.
 */

function cap(points, config) {
  return config.maxRoundPenalty === null ? points : Math.min(points, config.maxRoundPenalty);
}

/**
 * Penalty for a player left holding `hand` when somebody else declares validly.
 * Only UNMATCHED cards count. Cards inside valid groups are worth 0, and so are
 * jokers (config.unmatchedJokerValue).
 *
 * A hand with no possible LIFE is "not eligible" and is handled by
 * config.noLifeHandPolicy:
 *   'all-cards'      every card counts (non-joker cards by value)
 *   'unmatched-only' best groups without the LIFE requirement, count the rest
 *
 * @returns {{points: number, reason: string, hasLife: boolean,
 *            groups: {rank: string, cardIds: string[], isLife: boolean}[], unmatchedIds: string[]}}
 */
function scoreHand(hand, ctx) {
  const { config } = ctx;
  const best = findBestArrangement(hand, ctx, { objective: config.scoringObjective, requireLife: true });

  if (best.feasible) {
    return {
      points: cap(best.points, config),
      reason: PENALTY_REASON.UNMATCHED_CARDS,
      hasLife: true,
      groups: best.groups.map(toGroupSummary),
      unmatchedIds: best.unmatched.map((c) => c.id),
    };
  }

  if (config.noLifeHandPolicy === 'unmatched-only') {
    const partial = findBestArrangement(hand, ctx, { objective: config.scoringObjective, requireLife: false });
    return {
      points: cap(partial.points, config),
      reason: PENALTY_REASON.NO_LIFE_HAND,
      hasLife: false,
      groups: partial.groups.map(toGroupSummary),
      unmatchedIds: partial.unmatched.map((c) => c.id),
    };
  }

  const points = hand.reduce((sum, card) => sum + cardPoints(card, ctx), 0);
  return {
    points: cap(points, config),
    reason: PENALTY_REASON.NO_LIFE_HAND,
    hasLife: false,
    groups: [],
    unmatchedIds: hand.map((c) => c.id),
  };
}

function toGroupSummary(group) {
  return { rank: group.rank, cardIds: group.cards.map((c) => c.id), isLife: group.isLife };
}

/**
 * Score every player in `handsById` against a valid declaration.
 * @param {Object<string, object[]>} handsById
 */
function scoreOpponents(handsById, ctx) {
  const results = {};
  for (const [playerId, hand] of Object.entries(handsById)) results[playerId] = scoreHand(hand, ctx);
  return results;
}

/**
 * Drop penalty. A player who has not completed a turn yet drops for the first
 * (smaller) penalty, afterwards for the middle (bigger) one.
 * @returns {{type: 'first'|'middle', penalty: number, reason: string}}
 */
function dropPenalty(turnsTaken, config) {
  if (turnsTaken === 0) {
    return { type: 'first', penalty: config.firstDropPenalty, reason: PENALTY_REASON.FIRST_DROP };
  }
  return { type: 'middle', penalty: config.middleDropPenalty, reason: PENALTY_REASON.MIDDLE_DROP };
}

/** Fixed at 40 by the product rules (enforced in resolveConfig). */
function invalidDeclarationPenalty(config) {
  return config.invalidDeclarationPenalty;
}

module.exports = { scoreHand, scoreOpponents, dropPenalty, invalidDeclarationPenalty, cardPoints };
