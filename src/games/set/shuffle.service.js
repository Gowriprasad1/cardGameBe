'use strict';

const crypto = require('node:crypto');

/**
 * Cryptographically secure integer in [0, maxExclusive).
 * Every random decision in the engine goes through an `rng` with this
 * signature, so tests can inject a deterministic one.
 * @param {number} maxExclusive
 */
function secureRandomInt(maxExclusive) {
  return crypto.randomInt(maxExclusive);
}

/**
 * Unbiased Fisher-Yates shuffle. Returns a new array, input is untouched.
 * @template T
 * @param {T[]} items
 * @param {(maxExclusive: number) => number} [rng]
 * @returns {T[]}
 */
function shuffle(items, rng = secureRandomInt) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { secureRandomInt, shuffle };
