'use strict';

const { appError } = require('../constants/errors');
const { GamePersistence } = require('./game-persistence.service');

const PROCESSED_LIMIT = 500;

/**
 * Runs live games. It is the only thing that applies engine actions.
 *
 * Every action for a room goes through that room's queue, so two players'
 * simultaneous actions are applied strictly one after another. For each action:
 *
 *   engine.applyAction (pure)  ->  persist in ONE transaction  ->  swap in the new
 *   state  ->  publish events  ->  (re)arm the turn timer
 *
 * If persistence fails the in-memory state is left untouched, so memory and the
 * database can never disagree about an accepted action.
 */
class GameSessionService {
  constructor({ registry, persistence, emitter, presence, queue, logger, env }) {
    this.registry = registry;
    this.persistence = persistence;
    this.emitter = emitter;
    this.presence = presence;
    this.queue = queue;
    this.logger = logger;
    this.env = env;
    this.live = new Map(); // roomCode -> live session
    /** @type {((roomCode: string) => void)|null} set by the room service */
    this.onFinished = null;
  }

  has(roomCode) {
    return this.live.has(roomCode);
  }

  viewFor(roomCode, userId) {
    const live = this.live.get(roomCode);
    if (!live) throw appError('GAME_NOT_STARTED');
    if (!live.room.players.some((p) => p.userId === userId)) throw appError('NOT_IN_ROOM');
    return this.#viewOf(live, userId);
  }

  /** Create the game for a room whose host pressed Start. Call inside the room queue. */
  async start(room) {
    const module = this.registry.get(room.gameType);
    const players = room.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ id: p.userId, nickname: p.nickname }));
    const { state, events } = module.createGame({
      players,
      config: {
        turnTimerSeconds: this.env.turnTimerSeconds,
        reconnectGraceSeconds: this.env.reconnectGraceSeconds,
        // what the host chose when creating the room (e.g. points at which a player is out)
        ...(room.config || {}),
      },
    });
    const { sessionId, startedAt } = await this.persistence.startGame({ room, state });
    room.sessionId = sessionId;
    const live = this.#register(room, module, sessionId, startedAt, state);
    this.#publish(live, events);
  }

  /** Rebuild a live game from its saved snapshot after a restart. */
  restore(room, row) {
    const module = this.registry.get(room.gameType);
    room.sessionId = row.id;
    const live = this.#register(room, module, row.id, row.started_at, row.state_snapshot);
    this.#arm(live, this.#plan(live));
    return live;
  }

  /**
   * Apply a player's action.
   * @returns {Promise<{duplicate: boolean, view: object}>}
   */
  perform(roomCode, userId, action, requestId) {
    return this.queue.run(`room:${roomCode}`, async () => {
      const live = this.live.get(roomCode);
      if (!live) throw appError('GAME_NOT_STARTED');
      if (!live.room.players.some((p) => p.userId === userId)) throw appError('NOT_IN_ROOM');

      const key = requestId ? `${userId}:${requestId}` : null;
      if (key && live.processed.has(key)) return { duplicate: true, view: this.#viewOf(live, userId) };

      const outcome = await this.#commit(live, { ...action, playerId: userId }, requestId);
      if (!outcome.duplicate && key) this.#remember(live, key);
      return { duplicate: outcome.duplicate, view: this.#viewOf(live, userId) };
    });
  }

  /** A player is ready for the next round; when everyone connected is, deal now. */
  readyForNextRound(roomCode, userId) {
    return this.queue.run(`room:${roomCode}`, async () => {
      const live = this.live.get(roomCode);
      if (!live) throw appError('GAME_NOT_STARTED');
      if (!live.room.players.some((p) => p.userId === userId)) throw appError('NOT_IN_ROOM');
      if (live.state.stage !== 'between-rounds') return { started: false };
      live.ready.add(userId);
      const waitingFor = live.room.players.filter((p) => (
        live.state.players[p.userId].status === 'active' && this.presence.isConnected(p.userId) && !live.ready.has(p.userId)
      ));
      if (waitingFor.length > 0) return { started: false };
      await this.#commit(live, { type: 'start-next-round' });
      return { started: true };
    });
  }

  /** Called when a player connects or disconnects, so a stalled turn can get a timer. */
  onPresenceChange(roomCode) {
    return this.queue.run(`room:${roomCode}`, async () => {
      const live = this.live.get(roomCode);
      if (!live || live.finished) return;
      const plan = this.#plan(live);
      const same = plan && live.timerPlan && plan.kind === live.timerPlan.kind
        && plan.turnNo === live.timerPlan.turnNo && plan.roundNo === live.timerPlan.roundNo;
      if (!same) this.#arm(live, plan);
    }).catch((err) => this.logger.error('presence change failed', { err, roomCode }));
  }

  /** Drop a game from memory (idle cleanup). */
  forget(roomCode) {
    const live = this.live.get(roomCode);
    if (!live) return;
    clearTimeout(live.timer);
    this.live.delete(roomCode);
  }

  stop() {
    this.stopped = true;
    for (const live of this.live.values()) clearTimeout(live.timer);
  }

  // ---------------------------------------------------------------------------

  /** The engine's private view plus the platform's turn deadline (a timestamp, or null). */
  #viewOf(live, userId) {
    const view = live.module.viewFor(live.state, userId);
    const plan = live.timerPlan;
    view.turnDeadlineAt = plan && plan.kind === 'turn' ? plan.deadlineAt : null;
    return view;
  }

  #register(room, module, sessionId, startedAt, state) {
    const live = {
      room, module, sessionId, startedAt, state,
      processed: new Set(), timer: null, timerPlan: null, ready: new Set(), finished: state.stage === 'completed',
    };
    this.live.set(room.code, live);
    return live;
  }

  #remember(live, key) {
    live.processed.add(key);
    if (live.processed.size > PROCESSED_LIMIT) live.processed.delete(live.processed.values().next().value);
  }

  async #commit(live, action, requestId) {
    const prev = live.state;
    const { state: next, events } = live.module.applyAction(prev, action);
    const saved = await this.persistence.saveAction({
      room: live.room, sessionId: live.sessionId, startedAt: live.startedAt, prev, next, action, requestId, events,
    });
    if (saved.duplicate) return { duplicate: true };
    live.state = next;
    live.room.lastActivityAt = Date.now();
    live.ready.clear();
    this.#publish(live, events);
    return { duplicate: false };
  }

  /** Arm the timer, send events to their audience, then a personal full view to every player. */
  #publish(live, events) {
    const { room, state } = live;
    const code = room.code;
    const plan = this.#plan(live);
    const deadlineAt = plan && plan.kind === 'turn' ? Date.now() + plan.seconds * 1000 : null;

    if (state.stage === 'completed') {
      live.finished = true;
      clearTimeout(live.timer);
      live.timer = null;
      live.timerPlan = null;
    } else {
      // Armed first, so the views below carry the deadline of the turn that just began.
      this.#arm(live, plan, deadlineAt);
    }

    for (const event of events) {
      let { payload } = event;
      if (event.name === 'player-turn') payload = { ...payload, seconds: plan && plan.kind === 'turn' ? plan.seconds : 0, deadlineAt };
      if (event.to === 'all') this.emitter.toRoom(code, event.name, payload);
      else this.emitter.toUser(event.to, event.name, payload);
    }
    for (const p of room.players) this.emitter.toUser(p.userId, 'game-state', this.#viewOf(live, p.userId));

    if (live.finished && this.onFinished) this.onFinished(code);
  }

  /** What timer, if any, the current state needs. */
  #plan(live) {
    const { state } = live;
    if (state.stage === 'in-round') {
      const base = live.module.nextTimer(state);
      const current = state.round.currentPlayerId;
      let seconds = base ? base.seconds : 0;
      // With the turn timer off, a disconnected player must not freeze the table forever.
      if (!seconds && !this.presence.isConnected(current)) seconds = state.config.reconnectGraceSeconds;
      if (!seconds) return null;
      return { kind: 'turn', seconds, roundNo: state.round.no, turnNo: state.round.turnNo, playerId: current };
    }
    if (state.stage === 'between-rounds') {
      return { kind: 'next-round', seconds: this.env.roundBreakSeconds, roundNo: state.roundNo };
    }
    return null;
  }

  #arm(live, plan, deadlineAt) {
    clearTimeout(live.timer);
    live.timer = null;
    live.timerPlan = plan ? { ...plan, deadlineAt: deadlineAt ?? Date.now() + plan.seconds * 1000 } : null;
    if (!plan || this.stopped) return;
    live.timer = setTimeout(() => this.#fire(live.room.code, plan), plan.seconds * 1000);
  }

  #fire(roomCode, plan) {
    this.queue.run(`room:${roomCode}`, async () => {
      const live = this.live.get(roomCode);
      if (!live || live.finished) return;
      const { state } = live;
      if (plan.kind === 'turn') {
        const stale = state.stage !== 'in-round' || state.round.no !== plan.roundNo
          || state.round.turnNo !== plan.turnNo || state.round.currentPlayerId !== plan.playerId;
        if (stale) return;
        await this.#commit(live, { type: 'timeout', playerId: plan.playerId });
      } else {
        if (state.stage !== 'between-rounds' || state.roundNo !== plan.roundNo) return;
        await this.#commit(live, { type: 'start-next-round' });
      }
    }).catch((err) => {
      this.logger.error('timer action failed, retrying', { err, roomCode });
      const live = this.live.get(roomCode);
      if (live && !live.finished) this.#arm(live, { ...plan, seconds: 5 });
    });
  }
}

module.exports = { GameSessionService, GamePersistence };
