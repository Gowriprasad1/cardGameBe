'use strict';

const { createEngine } = require('../set/game-engine');
const { createViewFor } = require('../set/view');
const rules = require('./rummy-rules');
const { DEFAULT_CONFIG, resolveConfig } = require('./rummy.config');
const { GameError } = require('../set/errors');

const engine = createEngine(rules);

/** Indian Rummy (13 cards). Same module interface as SET, see platform/game-registry.js. */
module.exports = {
  code: 'RUMMY',
  name: 'Indian Rummy',
  minPlayers: 2,
  maxPlayers: 5,
  defaultConfig: DEFAULT_CONFIG,
  resolveConfig,
  createGame: engine.createGame,
  applyAction: engine.applyAction,
  viewFor: createViewFor(rules),
  nextTimer: engine.nextTimer,
  GameError,
};
