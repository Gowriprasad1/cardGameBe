'use strict';

const { GameError } = require('./errors');
const { RANKS } = require('./constants');

/**
 * Default SET rules. Every value is documented in docs/02-game-rules.md.
 * Overrides go through resolveConfig(), which rejects unknown keys and
 * enforces the rules that are fixed by the product (e.g. the 40 point
 * invalid-declaration penalty).
 */
const DEFAULT_CONFIG = Object.freeze({
  cardsPerPlayer: 13,
  minPlayers: 2,
  maxPlayers: 5,
  minGroupSize: 3,
  lifeMinNatural: 4,
  lifeRule: 'exactly', // 'exactly' (a LIFE is exactly 4 natural cards) | 'at-least' (4 or more)
  eliminationThreshold: 201,
  firstDropPenalty: 20,
  middleDropPenalty: 40,
  invalidDeclarationPenalty: 40,
  invalidDeclarationPolicy: 'remove-declarer', // 'remove-declarer' | 'continue-declarer' | 'end-round'
  openJokerMode: 'rank',
  openJokerNaturalInOwnRank: false,
  minNaturalInJokerGroup: 2,
  jokerInLifeGroup: 'extra-only',
  scoringObjective: 'min-points', // 'min-points' | 'max-matched'
  noLifeHandPolicy: 'all-cards', // 'all-cards' | 'unmatched-only'
  unmatchedJokerValue: 0,
  maxRoundPenalty: null,
  cardValues: Object.freeze({
    A: 10, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 10, Q: 10, K: 10,
  }),
  turnTimerSeconds: 60,
  autoDropAfterTimeouts: 3,
  reconnectGraceSeconds: 90,
  reshuffleOnEmpty: true,
  tieBreak: 'lowest-score',
});

const ENUMS = {
  invalidDeclarationPolicy: ['remove-declarer', 'continue-declarer', 'end-round'],
  openJokerMode: ['rank'],
  lifeRule: ['exactly', 'at-least'],
  jokerInLifeGroup: ['extra-only'],
  scoringObjective: ['min-points', 'max-matched'],
  noLifeHandPolicy: ['all-cards', 'unmatched-only'],
  tieBreak: ['lowest-score'],
};

function fail(message) {
  throw new GameError('INVALID_CONFIG', `Invalid game configuration: ${message}`);
}

function requireInt(config, key, min, max = Number.MAX_SAFE_INTEGER) {
  const v = config[key];
  if (!Number.isInteger(v) || v < min || v > max) fail(`${key} must be an integer between ${min} and ${max}`);
}

/**
 * Merge overrides onto the defaults and validate the result.
 * @param {object} [overrides]
 * @returns {typeof DEFAULT_CONFIG}
 */
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
  requireInt(config, 'minGroupSize', 3, 3);
  requireInt(config, 'lifeMinNatural', 4, 4);
  requireInt(config, 'eliminationThreshold', 1);
  requireInt(config, 'firstDropPenalty', 0);
  requireInt(config, 'middleDropPenalty', 0);
  if (config.invalidDeclarationPenalty !== 40) fail('invalidDeclarationPenalty is fixed at 40');
  requireInt(config, 'minNaturalInJokerGroup', 1, 2);
  requireInt(config, 'unmatchedJokerValue', 0);
  requireInt(config, 'turnTimerSeconds', 0);
  requireInt(config, 'autoDropAfterTimeouts', 1);
  requireInt(config, 'reconnectGraceSeconds', 0);
  if (config.maxRoundPenalty !== null) requireInt(config, 'maxRoundPenalty', 0);
  if (typeof config.openJokerNaturalInOwnRank !== 'boolean') fail('openJokerNaturalInOwnRank must be boolean');
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
