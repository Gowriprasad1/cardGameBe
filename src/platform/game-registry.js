'use strict';

const { appError } = require('../constants/errors');
const setGame = require('../games/set');
const rummyGame = require('../games/rummy');

/**
 * Maps a game code to its module. To add another card game later, create
 * `src/games/<name>/index.js` with the same interface as the SET module
 * (createGame, applyAction, viewFor, nextTimer) and register it here.
 */
function createGameRegistry(modules = [setGame, rummyGame]) {
  const byCode = new Map(modules.map((m) => [m.code, m]));
  return {
    get(code) {
      const mod = byCode.get(code);
      if (!mod) throw appError('UNSUPPORTED_GAME');
      return mod;
    },
    list: () => [...byCode.values()].map((m) => ({
      code: m.code, name: m.name, minPlayers: m.minPlayers, maxPlayers: m.maxPlayers,
    })),
  };
}

module.exports = { createGameRegistry };
