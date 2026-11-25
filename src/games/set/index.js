'use strict';

/**
 * SET game module. The platform (rooms, sockets, persistence) only talks to a
 * game through this interface, so more card games can be added later without
 * touching the platform.
 */

const { createGame, applyAction, nextTimer } = require('./game-engine');
const { viewFor } = require('./view');
const { DEFAULT_CONFIG, resolveConfig } = require('./set.config');
const { GameError } = require('./errors');

module.exports = {
  code: 'SET',
  name: 'Set Game',
  minPlayers: 2,
  maxPlayers: 5,
  defaultConfig: DEFAULT_CONFIG,
  resolveConfig,
  createGame,
  applyAction,
  viewFor,
  nextTimer,
  GameError,
};
