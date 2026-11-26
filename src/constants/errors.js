'use strict';

/** code -> [http status, default message] */
const CATALOG = Object.freeze({
  UNAUTHENTICATED: [401, 'Missing or invalid session token'],
  VALIDATION_FAILED: [400, 'Request validation failed'],
  UNSUPPORTED_GAME: [400, 'That game is not available'],
  NOT_FOUND: [404, 'Not found'],
  ROOM_NOT_FOUND: [404, 'Room not found'],
  ROOM_FULL: [409, 'Room is full'],
  ROOM_STARTED: [409, 'This game has already started'],
  ROOM_CLOSED: [409, 'This room is closed'],
  GAME_NOT_STARTED: [409, 'The game has not started yet'],
  NOT_HOST: [403, 'Only the host can do that'],
  NOT_ENOUGH_PLAYERS: [409, 'At least 2 players are needed to start'],
  NOT_IN_ROOM: [403, 'You are not in a room'],
  ALREADY_IN_ROOM: [409, 'You are already in another room'],
  GAME_IN_PROGRESS: [409, 'You cannot leave a game in progress'],
  LEFT_GAME: [409, 'You left this game and cannot rejoin it'],
  NAME_RESERVED: [400, 'That name belongs to the computer player. Please choose another one.'],
  FORBIDDEN: [403, 'You are not allowed to do that'],
  PAYLOAD_TOO_LARGE: [413, 'Payload too large'],
  RATE_LIMITED: [429, 'Too many requests, slow down'],
  DUPLICATE_REQUEST: [200, 'Request was already processed'],
  INTERNAL: [500, 'Something went wrong'],
});

class AppError extends Error {
  /**
   * @param {keyof typeof CATALOG} code
   * @param {string} [message]
   * @param {object} [details]
   */
  constructor(code, message, details) {
    const [status, defaultMessage] = CATALOG[code] || CATALOG.INTERNAL;
    super(message || defaultMessage);
    this.name = 'AppError';
    this.code = CATALOG[code] ? code : 'INTERNAL';
    this.status = status;
    this.details = details;
  }
}

/** @param {keyof typeof CATALOG} code @param {object} [details] @param {string} [message] */
function appError(code, details, message) {
  return new AppError(code, message, details);
}

/**
 * Convert any thrown value into the public error body. GameError (from the
 * engine) and AppError are safe to show. Anything else becomes INTERNAL, with
 * no internals leaked.
 * @returns {{status: number, body: {code: string, message: string, details?: object}, expected: boolean}}
 */
function toPublicError(err) {
  if (err instanceof AppError) {
    return { status: err.status, expected: true, body: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
  }
  if (err && err.name === 'GameError') {
    return { status: 409, expected: true, body: { code: err.code, message: err.message } };
  }
  return { status: 500, expected: false, body: { code: 'INTERNAL', message: CATALOG.INTERNAL[1] } };
}

module.exports = { AppError, appError, toPublicError, CATALOG };
