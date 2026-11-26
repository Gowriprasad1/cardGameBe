'use strict';

const { GameError } = require('../set/errors');
const { RANKS } = require('../set/constants');

/**
 * Default rules of Indian Rummy (13 cards), pool style. Every value is
 * documented in docs/08-rummy-rules.md. Overrides pass through resolveConfig(),
 * which rejects unknown keys.
 */
const DEFAULT_CONFIG = Object.freeze({
  cardsPerPlayer: 13,
  minPlayers: 2,
  maxPlayers: 5,
  eliminationThreshold: 201, // the host picks 101, 201 or 301 when creating the room
  firstDropPenalty: 20,
  middleDropPenalty: 40,
  invalidDeclarationPenalty: 80, // a wrong "show"
  invalidDeclarationPolicy: 'remove-declarer', // 'remove-declarer' | 'continue-declarer' | 'end-round'
  maxRoundPenalty: 80, // nobody is counted more than this in one round
  minNaturalInMeld: 1, // a sequence or set needs at least this many real cards (jokers fill the rest)
  maxSetSize: 4,
  openJokerMode: 'rank', // the face-up "cut joker": every card of its number is a wild joker
  cardValues: Object.freeze({
    A: 10, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 10, Q: 10, K: 10,
  }),
  jokerValue: 0, // printed jokers and wild-joker cards count nothing
  turnTimerSeconds: 60,
  autoDropAfterTimeouts: 3,
  reconnectGraceSeconds: 90,
  // after a valid declaration the other players get this long to arrange their cards and submit (0 = no wait)
  showWindowSeconds: 0,
  reshuffleOnEmpty: true,
  tieBreak: 'lowest-score',
});

const ENUMS = {
  invalidDeclarationPolicy: ['remove-declarer', 'continue-declarer', 'end-round'],
  openJokerMode: ['rank'],
  tieBreak: ['lowest-score'],
};

function fail(message) {
  throw new GameError('INVALID_CONFIG', `Invalid game configuration: ${message}`);
}

function requireInt(config, key, min, max = Number.MAX_SAFE_INTEGER) {
  const v = config[key];
  if (!Number.isInteger(v) || v < min || v > max) fail(`${key} must be an integer between ${min} and ${max}`);
}

/** @param {object} [overrides] */
function resolveConfig(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_CONFIG)) fail(`unknown option "${key}"`);
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    cardValues: { ...DEFAULT_CONFIG.cardValues, ...(overrides.cardValues || {}) },
  };
  if (config.cardsPerPlayer !== 13) fail('cardsPerPlayer is fixed at 13');
  requireInt(config, 'minPlayers', 2, 5);
  requireInt(config, 'maxPlayers', config.minPlayers, 5);
  requireInt(config, 'eliminationThreshold', 1);
  requireInt(config, 'firstDropPenalty', 0);
  requireInt(config, 'middleDropPenalty', 0);
  requireInt(config, 'invalidDeclarationPenalty', 0);
  requireInt(config, 'maxRoundPenalty', 0);
  requireInt(config, 'minNaturalInMeld', 1, 3);
  requireInt(config, 'maxSetSize', 3, 4);
  requireInt(config, 'jokerValue', 0);
  requireInt(config, 'turnTimerSeconds', 0);
  requireInt(config, 'autoDropAfterTimeouts', 1);
  requireInt(config, 'reconnectGraceSeconds', 0);
  requireInt(config, 'showWindowSeconds', 0, 300);
  if (typeof config.reshuffleOnEmpty !== 'boolean') fail('reshuffleOnEmpty must be boolean');
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(config[key])) fail(`${key} must be one of ${allowed.join(', ')}`);
  }
  for (const rank of RANKS) {
    const v = config.cardValues[rank];
    if (!Number.isInteger(v) || v < 0) fail(`cardValues.${rank} must be a non-negative integer`);
  }
  return Object.freeze(config);
}

module.exports = { DEFAULT_CONFIG, resolveConfig };
