'use strict';

/**
 * A cheap Rummy bot for whole-game tests: it plays turns (draw from the closed
 * pile, throw away the first card) and drops after `maxTurns`. Showing a hand
 * is tested separately with rigged hands, because searching for melds on every
 * turn would make whole games slow.
 */
function decideRummy(view, bot) {
  const phase = view.round.phase;
  if (phase === 'awaiting-end-turn') return { type: 'end-turn' };
  if (phase === 'awaiting-draw') {
    if (view.me.turnsTaken >= bot.maxTurns || (bot.quitsFirst && view.me.turnsTaken === 0)) return { type: 'drop' };
    return { type: 'draw', source: 'draw' };
  }
  return { type: 'discard', cardId: view.me.hand[0].id };
}

module.exports = { decideRummy };
