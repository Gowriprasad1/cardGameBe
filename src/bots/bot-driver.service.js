'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { topIsPickable, canSeeJoker } = require('../games/set/game-engine');

/** The computer player's name. Fixed: nobody can change it, and no person can take it. */
const BOT_NAME = 'mawa';

/** How long mawa "thinks" before each kind of move, in ms (a range, so it never feels mechanical). */
const THINK = {
  'turn-start': [1400, 3400],
  discard: [900, 2200],
  'end-of-turn': [600, 1400],
  submit: [3000, 7000],
};

/**
 * Plays for mawa in every game it sits in.
 *
 * After every accepted action the game service calls watch(). If it is now
 * mawa's move, the driver waits a human-like moment, asks the thinking
 * (on a worker thread) what to do, and sends the move through
 * gameSessions.perform: the very same path, checks and turn timer as a
 * person's move. What mawa may know is built in fairInput(): its own cards
 * and the public table, nothing else.
 */
class BotDriver {
  constructor({ gameSessions, logger, env }) {
    this.gameSessions = gameSessions;
    this.logger = logger;
    this.scale = env.botDelayScale ?? 1;
    this.pending = new Map(); // `${roomCode}:${botId}` -> {key, timer}
    this.worker = null;
    this.calls = new Map();
    this.seq = 0;
    this.requests = 0;
    this.stopped = false;
  }

  /** Called after every accepted action and after a game is restored. */
  watch(live) {
    if (this.stopped) return;
    for (const seat of live.room.players) {
      if (!seat.isBot) continue;
      const slot = `${live.room.code}:${seat.userId}`;
      const task = live.finished ? null : taskFor(live.state, seat.userId);
      const key = task ? `${live.state.version}:${task}` : null;
      const current = this.pending.get(slot);
      if (current && current.key === key) continue;
      if (current) clearTimeout(current.timer);
      if (!task) {
        this.pending.delete(slot);
        continue;
      }
      const [lo, hi] = THINK[task];
      const delay = Math.round((lo + Math.random() * (hi - lo)) * this.scale);
      const timer = setTimeout(() => {
        this.pending.delete(slot);
        this.#act(live.room.code, seat.userId, task, live.state.version)
          .catch((err) => this.logger.warn('mawa could not play', { err, roomCode: live.room.code }));
      }, delay);
      this.pending.set(slot, { key, timer });
    }
  }

  stop() {
    this.stopped = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.worker) this.worker.terminate().catch(() => {});
    this.worker = null;
  }

  async #act(roomCode, botId, task, version) {
    const fresh = () => {
      const live = this.gameSessions.live.get(roomCode);
      return live && !live.finished && live.state.version === version ? live : null;
    };
    const live = fresh();
    if (!live) return; // something happened meanwhile; watch() has planned the next move
    const result = await this.#think(task === 'submit' ? 'arrange' : task, fairInput(live.state, botId));
    if (!fresh()) return;

    const move = (action) => this.gameSessions.perform(roomCode, botId, action, `mawa-${Date.now()}-${(this.requests += 1)}`);
    switch (task) {
      case 'turn-start':
        if (result.type === 'declare') await move({ type: 'declare', groups: result.groups });
        else if (result.type === 'drop') await move({ type: 'drop' });
        else await move({ type: 'draw', source: result.source });
        break;
      case 'discard':
        if (result.declareGroups) {
          await move({ type: 'discard', cardId: result.cardId, endTurn: false });
          await move({ type: 'declare', groups: result.declareGroups });
        } else {
          await move({ type: 'discard', cardId: result.cardId, endTurn: true });
          if (result.oneCardToWin) await move({ type: 'one-card-to-win', active: true }).catch(() => {});
        }
        break;
      case 'end-of-turn':
        await move(result.type === 'declare' ? { type: 'declare', groups: result.groups } : { type: 'end-turn' });
        break;
      case 'submit':
        // if the layout is ever refused, submit the cards as they are rather than wait for the timer
        await move({ type: 'submit-show', groups: result }).catch(() => move({ type: 'submit-show' }));
        break;
      default:
        break;
    }
  }

  #think(task, input) {
    return new Promise((resolve, reject) => {
      const id = (this.seq += 1);
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`mawa took too long to think (${task})`));
      }, 15000);
      this.calls.set(id, { resolve, reject, timer });
      this.#workerThread().postMessage({ id, task, input });
    });
  }

  #workerThread() {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, 'mawa-worker.js'));
    worker.unref();
    worker.on('message', ({ id, result, error }) => {
      const call = this.calls.get(id);
      if (!call) return;
      this.calls.delete(id);
      clearTimeout(call.timer);
      if (error) call.reject(new Error(error));
      else call.resolve(result);
    });
    const fail = (err) => {
      if (this.worker === worker) this.worker = null;
      for (const [id, call] of this.calls) {
        clearTimeout(call.timer);
        call.reject(err || new Error('mawa thinking stopped'));
        this.calls.delete(id);
      }
    };
    worker.on('error', (err) => {
      this.logger.error('mawa thinking thread failed', { err });
      fail(err);
    });
    worker.on('exit', () => fail());
    this.worker = worker;
    return worker;
  }
}

/** What mawa should do now in this game, or null when it is not its move. */
function taskFor(state, botId) {
  const player = state.players[botId];
  if (!player || player.status !== 'active' || state.stage !== 'in-round') return null;
  const { round } = state;
  if (round.playerStatus[botId] !== 'playing') return null;
  if (round.phase === 'showing') return round.show && round.show.pending.includes(botId) ? 'submit' : null;
  if (round.currentPlayerId !== botId) return null;
  if (round.phase === 'awaiting-draw') return 'turn-start';
  if (round.phase === 'awaiting-discard') return 'discard';
  if (round.phase === 'awaiting-end-turn') return 'end-of-turn';
  return null;
}

/**
 * Everything mawa is allowed to know, and nothing more: the same as a person
 * in its seat sees. Its own cards, the open pile's top card, the face-up joker
 * number, the settings, the deck count, its own score and turns. Other
 * players' cards and the closed pile are never read here.
 */
function fairInput(state, botId) {
  const { round } = state;
  const top = round.discardPile.length > 0 ? round.discardPile[round.discardPile.length - 1] : null;
  return {
    game: state.game,
    config: state.config,
    // closed joker: like a person, mawa only knows the joker once it has a LIFE
    openJokerRank: canSeeJoker(state, botId) ? round.openJokerRank : null,
    deckCount: state.deckCount,
    hand: round.hands[botId].map((c) => ({ ...c })),
    top: top ? { ...top } : null,
    topPickable: topIsPickable(round),
    turnsTaken: round.turnsTaken[botId],
    myScore: state.players[botId].score,
    oneCardToWinFeature: state.game === 'SET',
  };
}

module.exports = { BotDriver, BOT_NAME, fairInput, taskFor };
