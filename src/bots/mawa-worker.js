'use strict';

/**
 * Runs mawa's thinking on its own thread. Judging a Rummy hand can take a
 * few hundred milliseconds; on the main thread that would pause every other
 * game on the server, so it happens here instead.
 */
const { parentPort } = require('node:worker_threads');
const brain = require('./mawa-brain');

const TASKS = {
  'turn-start': brain.decideTurnStart,
  discard: brain.decideDiscard,
  'end-of-turn': brain.decideEndOfTurn,
  arrange: brain.arrange,
};

parentPort.on('message', ({ id, task, input }) => {
  try {
    const run = TASKS[task];
    if (!run) throw new Error(`unknown task ${task}`);
    const result = task === 'arrange' ? run(withRandom(input), input.hand) : run(withRandom(input));
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message || String(err) });
  }
});

/** Functions cannot cross threads: the thinking gets its own randomness here. */
function withRandom(input) {
  return { ...input, random: Math.random };
}
