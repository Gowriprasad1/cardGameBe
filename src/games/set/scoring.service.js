'use strict';

const { findBestArrangement } = require('./arrangement.service');
const { cardPoints } = require('./card-values');
const { PENALTY_REASON } = require('./constants');
const { jokerType } = require('./joker.service');

/**
 * All scoring happens here, on the backend. Nothing the client sends is ever
 * used to compute points.
 */

function cap(points, config) {
  return config.maxRoundPenalty === null ? points : Math.min(points, config.maxRoundPenalty);
}

/**
 * Penalty for a player left holding `hand` when somebody else declares validly.
 * Only cards that are NOT in a valid set count. Cards inside valid groups are
 * worth 0 and so are jokers that are used in a group.
 *
 * What a LIFE is for:
 *  - WITH a LIFE (exactly 4 natural cards) jokers are usable. A single natural
 *    card plus two jokers is a valid set, so the best grouping is found with the
 *    jokers helping (e.g. 4,4,4,4 + 8,8,8 + K + 2 jokers + 2,J,Q = K and the two
 *    jokers form a set, so only 2+J+Q = 22 count).
 *  - WITHOUT a LIFE the jokers cannot be used. The natural cards still form
 *    their valid sets and only the cards outside them count, plus every joker
 *    at config.deadJokerValue (2). Example: four sets of three + an 8 = 8;
 *    four sets of three + a joker = 2.
 *
 * config.noLifeHandPolicy 'all-cards' (not the default) instead counts every
 * card of a hand that has no LIFE.
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
    // No LIFE: jokers are dead weight, the natural cards form whatever sets they can.
    const isDeadJoker = (card) => {
      const type = jokerType(card, ctx);
      if (type === 'printed') return true;
      return type === 'open' && !config.openJokerNaturalInOwnRank;
    };
    const dead = hand.filter(isDeadJoker);
    const naturals = hand.filter((c) => !isDeadJoker(c));
    const partial = findBestArrangement(naturals, ctx, { objective: config.scoringObjective, requireLife: false });
    return {
      points: cap(partial.points + dead.length * config.deadJokerValue, config),
      reason: PENALTY_REASON.NO_LIFE_HAND,
      hasLife: false,
      groups: partial.groups.map(toGroupSummary),
      unmatchedIds: [...partial.unmatched, ...dead].map((c) => c.id),
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
