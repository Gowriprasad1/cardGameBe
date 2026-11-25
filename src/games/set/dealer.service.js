'use strict';

const { secureRandomInt } = require('./shuffle.service');

/**
 * Random first dealer, chosen by the backend.
 * @param {string[]} seatOrder player ids in seat (clockwise) order
 */
function pickInitialDealer(seatOrder, rng = secureRandomInt) {
  return seatOrder[rng(seatOrder.length)];
}

/**
 * First player after `afterId` (clockwise) who is in `eligibleIds`.
 * `afterId` itself does not need to be eligible (a dealer may have just been
 * eliminated). Returns null if nobody is eligible.
 * @param {string[]} seatOrder
 * @param {string} afterId
 * @param {string[]} eligibleIds
 */
function nextEligibleAfter(seatOrder, afterId, eligibleIds) {
  const eligible = new Set(eligibleIds);
  const start = seatOrder.indexOf(afterId);
  for (let i = 1; i <= seatOrder.length; i += 1) {
    const id = seatOrder[(start + i) % seatOrder.length];
    if (eligible.has(id)) return id;
  }
  return null;
}

/** The dealer rotates clockwise each round, skipping eliminated players. */
const nextDealer = nextEligibleAfter;

/** The player after the dealer plays first. */
const firstToPlay = nextEligibleAfter;

module.exports = { pickInitialDealer, nextEligibleAfter, nextDealer, firstToPlay };
