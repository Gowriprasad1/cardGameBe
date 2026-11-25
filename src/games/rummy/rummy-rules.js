'use strict';

const { resolveConfig } = require('./rummy.config');
const { validateDeclaration } = require('./declaration');
const { scoreHand } = require('./scoring');
const { dropPenalty } = require('../set/scoring.service');

/**
 * Indian Rummy plugged into the shared draw-and-discard engine.
 * "1 CARD TO WIN" is not offered in this game (see docs/08-rummy-rules.md).
 */
module.exports = {
  code: 'RUMMY',
  features: { oneCardToWin: false },
  resolveConfig,
  validateDeclaration,
  scoreHand,
  dropPenalty,
  invalidDeclarationPenalty: (config) => config.invalidDeclarationPenalty,
  checkOneCardToWin: () => ({ eligible: false, waitingFor: [] }),
};
