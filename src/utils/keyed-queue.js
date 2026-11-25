'use strict';

/**
 * Runs async tasks one at a time per key. This is what stops two players'
 * simultaneous actions in the same room from interleaving: every action for a
 * room goes through `run(roomKey, ...)` and is applied strictly in order.
 */
class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>|T} task
   * @returns {Promise<T>}
   */
  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const result = previous.then(() => task());
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

module.exports = { KeyedQueue };
