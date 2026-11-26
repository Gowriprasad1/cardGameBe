'use strict';

const rooms = require('../db/repositories/rooms.repository');
const sessions = require('../db/repositories/sessions.repository');

/**
 * Writes game state to PostgreSQL. Every method is ONE transaction, so a crash
 * can never leave a half-written deal, a half-applied score or a round that is
 * completed without its scores.
 *
 * What is written when:
 *  - every accepted action : game_actions row + session snapshot/version
 *  - round dealt           : game_rounds, round_players, card_decks, player_cards
 *  - round finished        : round result, player_scores, cumulative scores,
 *                            eliminations, final card positions
 *  - game finished         : session + room status, game_history
 *
 * During a round the session snapshot is the recoverable copy of the cards.
 */
class GamePersistence {
  constructor({ db, keepFullGameData = false }) {
    this.db = db;
    this.keepFullGameData = keepFullGameData;
    /** `${sessionId}:${roundNo}` -> game_rounds.id, so an action does not need a lookup query */
    this.roundIds = new Map();
  }

  /** Forget cached ids of a session (used when a transaction fails and may have rolled them back). */
  purge(sessionId) {
    for (const key of [...this.roundIds.keys()]) if (key.startsWith(`${sessionId}:`)) this.roundIds.delete(key);
  }

  async roundIdFor(tx, sessionId, roundNo) {
    const key = `${sessionId}:${roundNo}`;
    let id = this.roundIds.get(key);
    if (!id) {
      id = await sessions.findRoundId(tx, { sessionId, roundNo });
      if (id) this.roundIds.set(key, id);
    }
    return id;
  }

  /** userId -> room_players.id for this room */
  static roomPlayerIdOf(room) {
    const map = new Map(room.players.map((p) => [p.userId, p.roomPlayerId]));
    return (userId) => {
      const id = map.get(userId);
      if (!id) throw new Error(`user ${userId} has no seat in room ${room.code}`);
      return id;
    };
  }

  /** Create the session and deal round 1. */
  async startGame({ room, state }) {
    const rp = GamePersistence.roomPlayerIdOf(room);
    return this.db.withTransaction(async (tx) => {
      const gameTypeId = await rooms.getGameTypeId(tx, room.gameType);
      const session = await sessions.insertSession(tx, {
        roomId: room.id,
        gameTypeId,
        config: state.config,
        deckCount: state.deckCount,
        firstDealerId: rp(state.round.dealerId),
        snapshot: state,
        version: state.version,
      });
      await rooms.setRoomStatus(tx, { roomId: room.id, status: 'in_progress' });
      await this.persistRoundStart(tx, session.id, state, rp);
      return { sessionId: session.id, startedAt: session.started_at };
    });
  }

  /**
   * Persist one accepted action together with everything it caused.
   * @returns {Promise<{duplicate: boolean}>}
   */
  async saveAction(args) {
    try {
      return await this.#saveAction(args);
    } catch (err) {
      this.purge(args.sessionId); // a rolled-back round start must not leave a stale id behind
      throw err;
    }
  }

  async #saveAction({ room, sessionId, startedAt, prev, next, action, requestId, events }) {
    const rp = GamePersistence.roomPlayerIdOf(room);
    const { type, playerId, ...payload } = action;
    const record = (db) => sessions.recordAction(db, {
      sessionId,
      roundNo: prev.round ? prev.round.no : null,
      roomPlayerId: playerId ? rp(playerId) : null,
      actionType: type,
      payload,
      idempotencyKey: requestId || null,
      version: next.version,
      snapshot: next,
      currentRoundNo: next.roundNo,
    });
    const check = (r) => {
      if (r.inserted === 0) return { duplicate: true };
      if (r.updated === 0) throw new Error('session snapshot version conflict');
      return null;
    };

    const roundStarts = next.roundNo > prev.roundNo;
    const roundEnds = Boolean(prev.round && next.round && prev.round.no === next.round.no && !prev.round.result && next.round.result);
    const gameEnds = next.stage === 'completed' && prev.stage !== 'completed';
    const someoneLeft = type === 'leave' && next.players[playerId] && next.players[playerId].status === 'left';

    // The common case (a draw, a discard, a drop...) is ONE statement and ONE round trip.
    if (!roundStarts && !roundEnds && !gameEnds && !someoneLeft) return check(await record(this.db)) || { duplicate: false };

    return this.db.withTransaction(async (tx) => {
      const early = check(await record(tx));
      if (early) return early;
      if (someoneLeft) await rooms.setRoomPlayerLeft(tx, { roomPlayerId: rp(playerId) });
      if (roundStarts) await this.persistRoundStart(tx, sessionId, next, rp);
      if (roundEnds) await this.persistRoundEnd(tx, { sessionId, state: next, rp });
      if (gameEnds) await this.persistGameEnd(tx, { room, sessionId, startedAt, state: next, events, rp });
      return { duplicate: false };
    });
  }

  /** Mark a session and its room abandoned (idle cleanup). */
  async abandon({ roomId, sessionId }) {
    return this.db.withTransaction(async (tx) => {
      if (sessionId) {
        await sessions.completeSession(tx, { sessionId, winnerRoomPlayerId: null, status: 'abandoned' });
        if (!this.keepFullGameData) await sessions.purgeSessionDetails(tx, sessionId);
      }
      await rooms.setRoomStatus(tx, { roomId, status: 'abandoned' });
    });
  }

  async persistRoundStart(tx, sessionId, state, rp) {
    const { round } = state;
    const roundId = await sessions.insertRound(tx, {
      sessionId,
      roundNo: round.no,
      dealerRoomPlayerId: rp(round.dealerId),
      openJokerRank: round.openJokerRank,
    });
    this.roundIds.set(`${sessionId}:${round.no}`, roundId);
    await sessions.insertRoundPlayers(tx, roundId, round.order.map((userId, i) => ({ roomPlayerId: rp(userId), turnOrder: i })));
    await sessions.replaceRoundCards(tx, roundId, round, rp);
  }

  async persistRoundEnd(tx, { sessionId, state, rp }) {
    const { round } = state;
    const roundId = await this.roundIdFor(tx, sessionId, round.no);
    await sessions.completeRound(tx, {
      roundId,
      winnerRoomPlayerId: round.result.winnerId ? rp(round.result.winnerId) : null,
      endReason: round.result.endReason,
      turnNo: round.turnNo,
    });
    await sessions.updateRoundPlayers(tx, roundId, round.order.map((userId) => ({
      roomPlayerId: rp(userId),
      status: round.playerStatus[userId],
      turnsTaken: round.turnsTaken[userId],
      timeouts: round.timeouts[userId],
      oneCardToWin: Boolean(round.oneCardToWin[userId]),
    })));
    await sessions.insertScores(tx, {
      sessionId,
      roundId,
      rows: round.result.results.map((r) => ({
        roomPlayerId: rp(r.playerId),
        reason: r.reason,
        penalty: r.penalty,
        unmatched: round.penalties[r.playerId].unmatchedIds || [],
        cumulativeAfter: r.cumulativeScore,
        eliminatedNow: r.eliminated,
      })),
    });
    await sessions.updateRoomPlayerTotals(tx, state.seatOrder.map((userId) => {
      const player = state.players[userId];
      return {
        roomPlayerId: rp(userId),
        score: player.score,
        drops: player.drops,
        eliminated: player.status === 'eliminated',
        eliminatedRoundNo: player.eliminatedInRound,
      };
    }));
    await sessions.replaceRoundCards(tx, roundId, round, rp);
  }

  async persistGameEnd(tx, { room, sessionId, startedAt, state, events, rp }) {
    const done = events.find((e) => e.name === 'game-completed');
    for (const key of [...this.roundIds.keys()]) if (key.startsWith(`${sessionId}:`)) this.roundIds.delete(key);
    await sessions.completeSession(tx, { sessionId, winnerRoomPlayerId: rp(state.winnerId) });
    await rooms.setRoomStatus(tx, { roomId: room.id, status: 'finished' });
    await sessions.insertHistory(tx, {
      sessionId,
      roomId: room.id,
      winnerUserId: state.winnerId,
      totalRounds: state.roundNo,
      finalScoreboard: done.payload.finalScoreboard,
      eliminatedHistory: done.payload.eliminatedHistory,
      startedAt,
    });
    // The game is over and its result is saved: drop the working data (cards, action log, saved state).
    if (!this.keepFullGameData) await sessions.purgeSessionDetails(tx, sessionId);
  }
}

module.exports = { GamePersistence };
