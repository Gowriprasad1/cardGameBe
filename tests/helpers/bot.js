'use strict';

/**
 * A rules-following bot that only uses what a real client sees: its own
 * private view. Used by the whole-game simulations and the socket tests.
 */

const { findBestArrangement } = require('../../src/games/set/arrangement.service');
const { resolveConfig } = require('../../src/games/set/set.config');

const toCard = (c) => ({ id: c.id, rank: c.rank, suit: c.suit, joker: c.isPrintedJoker });

/**
 * One decision for the active player.
 * @param {object} view the player's `viewFor` projection
 * @param {{maxTurns: number, quitsFirst?: boolean}} bot
 * @returns {{type: string, [k: string]: any}} an action (without requestId)
 */
function decideFromView(view, bot) {
  const me = view.me;
  const hand = me.hand.map(toCard);
  const ctx = { config: resolveConfig(), openJokerRank: view.round.openJokerRank };
  const phase = view.round.phase;
  const groupsOf = (best) => best.groups.map((g) => g.cards.map((c) => c.id));

  if (phase === 'awaiting-draw' || phase === 'awaiting-end-turn') {
    const best = findBestArrangement(hand, ctx, { objective: 'max-matched', requireLife: true });
    if (best.feasible && best.matchedCount === 13) return { type: 'declare', groups: groupsOf(best) };
    if (phase === 'awaiting-end-turn') return { type: 'end-turn' };
    if (me.turnsTaken >= bot.maxTurns || (bot.quitsFirst && me.turnsTaken === 0)) return { type: 'drop' };
    const top = view.round.discardTop;
    const counts = {};
    for (const c of hand) if (!c.joker) counts[c.rank] = (counts[c.rank] || 0) + 1;
    const takeDiscard = top && !top.isPrintedJoker && (counts[top.rank] || 0) >= 2;
    return { type: 'draw', source: takeDiscard ? 'discard' : 'draw' };
  }

  // awaiting-discard with 14 cards: look for a discard that leaves a perfect hand
  const best14 = findBestArrangement(hand, ctx, { objective: 'max-matched', requireLife: true });
  if (best14.feasible && best14.matchedCount >= 13) {
    for (const c of hand) {
      const rest = hand.filter((x) => x.id !== c.id);
      const arr = findBestArrangement(rest, ctx, { objective: 'max-matched', requireLife: true });
      if (arr.feasible && arr.matchedCount === 13) return { type: 'discard', cardId: c.id, endTurn: false };
    }
  }
  const counts = {};
  for (const c of hand) if (!c.joker) counts[c.rank] = (counts[c.rank] || 0) + 1;
  const worth = (c) => (c.joker || c.rank === ctx.openJokerRank ? -1 : counts[c.rank] * 100 - ctx.config.cardValues[c.rank]);
  const victim = hand.slice().sort((a, b) => worth(a) - worth(b))[0];
  return { type: 'discard', cardId: victim.id };
}

module.exports = { decideFromView };
