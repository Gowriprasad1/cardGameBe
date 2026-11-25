'use strict';

const { resolveConfig } = require('./set.config');
const { validateDeclaration } = require('./declaration.service');
const { scoreHand, dropPenalty, invalidDeclarationPenalty } = require('./scoring.service');
const { checkOneCardToWin } = require('./one-card-to-win.service');

/** The rules of SET Game, as plugged into the shared draw-and-discard engine. */
module.exports = {
  code: 'SET',
  features: { oneCardToWin: true },
  resolveConfig,
  validateDeclaration,
  scoreHand,
  dropPenalty,
  invalidDeclarationPenalty,
  checkOneCardToWin,
};
