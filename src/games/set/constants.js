'use strict';

const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const SUITS = Object.freeze(['H', 'D', 'C', 'S']);

/** Phases of the active player's turn. */
const PHASE = Object.freeze({
  AWAITING_DRAW: 'awaiting-draw',
  AWAITING_DISCARD: 'awaiting-discard',
  AWAITING_END_TURN: 'awaiting-end-turn',
  /** someone made a valid declaration; the others arrange their cards and submit */
  SHOWING: 'showing',
});

/** Stage of the whole game. */
const STAGE = Object.freeze({
  IN_ROUND: 'in-round',
  BETWEEN_ROUNDS: 'between-rounds',
  COMPLETED: 'completed',
});

/** Player status across the whole game. */
const PLAYER_STATUS = Object.freeze({
  ACTIVE: 'active',
  ELIMINATED: 'eliminated',
  /** pressed Exit: out of the game for good */
  LEFT: 'left',
});

/** Player status inside one round. Mirrors round_players.status in the database. */
const ROUND_STATUS = Object.freeze({
  PLAYING: 'playing',
  DROPPED_FIRST: 'dropped_first',
  DROPPED_MIDDLE: 'dropped_middle',
  REMOVED_INVALID: 'removed_invalid_declaration',
  WINNER: 'winner',
  LEFT: 'left',
});

/** Mirrors game_rounds.end_reason. */
const END_REASON = Object.freeze({
  VALID_DECLARATION: 'valid_declaration',
  LAST_PLAYER_STANDING: 'last_player_standing',
  INVALID_DECLARATION_END: 'invalid_declaration_end',
});

/** Mirrors player_scores.reason. */
const PENALTY_REASON = Object.freeze({
  WINNER: 'winner',
  UNMATCHED_CARDS: 'unmatched_cards',
  NO_LIFE_HAND: 'no_life_hand',
  FIRST_DROP: 'first_drop',
  MIDDLE_DROP: 'middle_drop',
  INVALID_DECLARATION: 'invalid_declaration',
  NO_PENALTY: 'no_penalty',
  /** left the game during the round: no points */
  LEFT: 'left',
});

module.exports = { RANKS, SUITS, PHASE, STAGE, PLAYER_STATUS, ROUND_STATUS, END_REASON, PENALTY_REASON };
