'use strict';

const { PHASE, PLAYER_STATUS, ROUND_STATUS } = require('./constants');
const { gameError } = require('./errors');

/**
 * Turn validation. Every check here runs on the server before a turn action
 * (draw, discard, end-turn, drop, declare) is applied.
 */

/**
 * Ensure `playerId` is a live participant of the current round.
 * @param {object} state game state
 */
function assertPlayerInRound(state, playerId) {
  const player = state.players[playerId];
  if (!player) throw gameError('NOT_IN_ROOM');
  if (player.status === PLAYER_STATUS.ELIMINATED) throw gameError('PLAYER_ELIMINATED');
  if (player.status === PLAYER_STATUS.LEFT) throw gameError('PLAYER_LEFT');
  const round = state.round;
  if (!round || !round.order.includes(playerId) || round.playerStatus[playerId] !== ROUND_STATUS.PLAYING) {
    throw gameError('NOT_IN_ROUND');
  }
}

/** Ensure it is `playerId`'s turn. */
function assertActivePlayer(state, playerId) {
  assertPlayerInRound(state, playerId);
  if (state.round.currentPlayerId !== playerId) throw gameError('NOT_YOUR_TURN');
}

/** Ensure the turn is in one of the allowed phases, with a precise error otherwise. */
function assertPhase(round, allowed, action) {
  if (allowed.includes(round.phase)) return;
  if (action === 'draw') {
    throw gameError(round.phase === PHASE.AWAITING_DISCARD ? 'ALREADY_DRAWN' : 'ALREADY_DISCARDED');
  }
  if (action === 'discard') {
    throw gameError(round.phase === PHASE.AWAITING_DRAW ? 'MUST_DRAW_FIRST' : 'ALREADY_DISCARDED');
  }
  if (action === 'end-turn') {
    throw gameError(round.phase === PHASE.AWAITING_DRAW ? 'MUST_DRAW_FIRST' : 'TURN_NOT_FINISHED');
  }
  if (action === 'drop') throw gameError('DROP_NOT_ALLOWED');
  if (action === 'declare') throw gameError('DECLARATION_NOT_ALLOWED');
  throw gameError('NOT_YOUR_TURN');
}

/** Next player after `fromId` (clockwise) who is still playing this round. */
function nextPlaying(round, fromId) {
  const n = round.order.length;
  const start = round.order.indexOf(fromId);
  for (let i = 1; i <= n; i += 1) {
    const id = round.order[(start + i) % n];
    if (round.playerStatus[id] === ROUND_STATUS.PLAYING) return id;
  }
  return null;
}

/** Players still playing this round, in turn order. */
function playingIds(round) {
  return round.order.filter((id) => round.playerStatus[id] === ROUND_STATUS.PLAYING);
}

module.exports = { assertPlayerInRound, assertActivePlayer, assertPhase, nextPlaying, playingIds };
