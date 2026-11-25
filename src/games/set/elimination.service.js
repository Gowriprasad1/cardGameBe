'use strict';

const { PLAYER_STATUS } = require('./constants');

/**
 * Elimination rules: a player whose cumulative score reaches or exceeds the
 * threshold (201) is eliminated. The game ends when exactly one eligible
 * player remains.
 */

/** Ids (in seat order) of players still in the game. */
function eligibleIds(players, seatOrder) {
  return seatOrder.filter((id) => players[id].status === PLAYER_STATUS.ACTIVE);
}

/**
 * Active players whose score is now at or above the threshold.
 * Does NOT mutate. Use markEliminated() to apply.
 */
function findNewlyEliminated(players, seatOrder, threshold) {
  return seatOrder.filter((id) => players[id].status === PLAYER_STATUS.ACTIVE && players[id].score >= threshold);
}

/** Mark players as eliminated, keeping their score history. */
function markEliminated(players, ids, roundNo) {
  for (const id of ids) {
    players[id].status = PLAYER_STATUS.ELIMINATED;
    players[id].eliminatedInRound = roundNo;
  }
}

/**
 * Decide whether the game is over.
 * - exactly one eligible player: that player wins
 * - nobody eligible (everyone crossed the threshold in the same round): tie
 *   break by lowest cumulative score, then by seat order
 * - otherwise the game continues
 * @returns {{finished: boolean, winnerId: string|null}}
 */
function resolveGameEnd({ players, seatOrder, newlyEliminated }) {
  const remaining = eligibleIds(players, seatOrder);
  if (remaining.length > 1) return { finished: false, winnerId: null };
  if (remaining.length === 1) return { finished: true, winnerId: remaining[0] };

  const pool = newlyEliminated.length > 0 ? newlyEliminated : seatOrder;
  let winnerId = pool[0];
  for (const id of pool) if (players[id].score < players[winnerId].score) winnerId = id;
  return { finished: true, winnerId };
}

module.exports = { eligibleIds, findNewlyEliminated, markEliminated, resolveGameEnd };
