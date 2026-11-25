'use strict';

const MESSAGES = Object.freeze({
  INVALID_PLAYER_COUNT: 'SET needs between 2 and 5 players',
  INVALID_CONFIG: 'Invalid game configuration',
  DUPLICATE_PLAYER: 'Duplicate player in game',
  NOT_IN_ROOM: 'Player is not part of this game',
  PLAYER_ELIMINATED: 'Eliminated players cannot act',
  NOT_IN_ROUND: 'Player is not playing in this round',
  ROUND_NOT_ACTIVE: 'No round is currently in progress',
  GAME_FINISHED: 'The game has finished',
  NOT_YOUR_TURN: 'It is not your turn',
  ALREADY_DRAWN: 'You have already drawn a card this turn',
  MUST_DRAW_FIRST: 'You must draw a card first',
  ALREADY_DISCARDED: 'You have already discarded this turn',
  CARD_NOT_IN_HAND: 'That card is not in your hand',
  PILE_EMPTY: 'That pile is empty',
  INVALID_SOURCE: 'Draw source must be "draw" or "discard"',
  INVALID_ARRANGEMENT: 'Arrangement must contain exactly your cards, each once',
  DROP_NOT_ALLOWED: 'You can only drop at the start of your turn, before drawing',
  DECLARATION_NOT_ALLOWED: 'You can only declare with 13 cards, on your turn',
  ONE_CARD_NOT_ELIGIBLE: 'Your hand does not qualify for 1 CARD TO WIN',
  TURN_NOT_FINISHED: 'Discard a card before ending your turn',
  UNKNOWN_ACTION: 'Unknown action',
  NOT_BETWEEN_ROUNDS: 'The next round cannot be started now',
  INTEGRITY_VIOLATION: 'Card integrity violated',
});

class GameError extends Error {
  /**
   * @param {string} code machine readable code, see MESSAGES
   * @param {string} [message]
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message || MESSAGES[code] || code);
    this.name = 'GameError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {object} [details] */
function gameError(code, details) {
  return new GameError(code, undefined, details);
}

module.exports = { GameError, gameError, MESSAGES };
