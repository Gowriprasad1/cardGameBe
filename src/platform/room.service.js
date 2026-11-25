'use strict';

const { appError } = require('../constants/errors');
const roomsRepo = require('../db/repositories/rooms.repository');
const sessionsRepo = require('../db/repositories/sessions.repository');
const { isUniqueViolation } = require('../db/pool');
const usersRepo = require('../db/repositories/users.repository');
const { generateRoomCode } = require('../utils/ids');

const GUEST_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;

/**
 * Rooms, membership and presence.
 *
 * Live rooms are kept in memory (fast, single backend instance) and mirrored to
 * PostgreSQL. Every mutation of one room runs inside that room's queue, and the
 * database unique keys (room code, user per room, seat per room) are the final
 * backstop against duplicates.
 */
class RoomService {
  constructor({ db, registry, emitter, presence, gameSessions, persistence, queue, logger, env }) {
    this.db = db;
    this.registry = registry;
    this.emitter = emitter;
    this.presence = presence;
    this.gameSessions = gameSessions;
    this.persistence = persistence;
    this.queue = queue;
    this.logger = logger;
    this.env = env;
    this.rooms = new Map(); // code -> room
    this.userRoom = new Map(); // userId -> code
    this.sweeper = null;
    gameSessions.onFinished = (code) => this.#onGameFinished(code);
  }

  // ---- read side -----------------------------------------------------------

  activeRoomCode(userId) {
    return this.userRoom.get(userId) || null;
  }

  /** Public, non-secret room description (also used for the Join screen). */
  preview(code) {
    const room = this.rooms.get(code);
    if (!room) throw appError('ROOM_NOT_FOUND');
    return {
      roomCode: room.code,
      gameType: room.gameType,
      status: room.status,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      joinable: room.status === 'waiting' && room.players.length < room.maxPlayers,
    };
  }

  publicRoom(room) {
    return {
      roomCode: room.code,
      gameType: room.gameType,
      status: room.status,
      hostId: room.hostUserId,
      sessionId: room.sessionId || null,
      minPlayers: MIN_PLAYERS,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.length,
      players: room.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          playerId: p.userId,
          nickname: p.nickname,
          seat: p.seat,
          isHost: p.userId === room.hostUserId,
          isConnected: this.presence.isConnected(p.userId),
          status: p.status,
        })),
    };
  }

  // ---- commands ------------------------------------------------------------

  createRoom(user, gameType = 'SET') {
    this.registry.get(gameType);
    return this.queue.run(`user:${user.id}`, async () => {
      this.#assertFree(user.id);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateRoomCode();
        if (this.rooms.has(code)) continue;
        try {
          const room = await this.db.withTransaction(async (tx) => {
            const gameTypeId = await roomsRepo.getGameTypeId(tx, gameType);
            const roomId = await roomsRepo.insertRoom(tx, { roomCode: code, gameTypeId, hostUserId: user.id, maxPlayers: MAX_PLAYERS });
            const roomPlayerId = await roomsRepo.insertRoomPlayer(tx, { roomId, userId: user.id, seatNo: 0 });
            return {
              id: roomId, code, gameType, hostUserId: user.id, status: 'waiting', maxPlayers: MAX_PLAYERS, sessionId: null,
              lastActivityAt: Date.now(),
              players: [{ userId: user.id, nickname: user.nickname, seat: 0, roomPlayerId, status: 'active' }],
            };
          });
          this.rooms.set(code, room);
          this.userRoom.set(user.id, code);
          return { roomCode: code, room: this.publicRoom(room) };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err; // code collision: try another
        }
      }
      throw new Error('could not allocate a room code');
    });
  }

  joinRoom(user, rawCode) {
    return this.queue.run(`user:${user.id}`, () => this.queue.run(`room:${rawCode}`, async () => {
      const room = this.rooms.get(rawCode);
      if (!room) throw appError('ROOM_NOT_FOUND');
      const existing = room.players.find((p) => p.userId === user.id);
      if (existing) {
        // Already seated: joining again is just reconnecting. Never a duplicate entry.
        this.userRoom.set(user.id, room.code);
        return { roomCode: room.code, room: this.publicRoom(room), rejoined: true };
      }
      if (room.status === 'finished' || room.status === 'abandoned') throw appError('ROOM_CLOSED');
      if (room.status !== 'waiting') throw appError('ROOM_STARTED');
      if (room.players.length >= room.maxPlayers) throw appError('ROOM_FULL');
      this.#assertFree(user.id);

      const taken = new Set(room.players.map((p) => p.seat));
      let seat = 0;
      while (taken.has(seat)) seat += 1;
      const roomPlayerId = await this.db.withTransaction((tx) => roomsRepo.insertRoomPlayer(tx, { roomId: room.id, userId: user.id, seatNo: seat }));
      room.players.push({ userId: user.id, nickname: user.nickname, seat, roomPlayerId, status: 'active' });
      room.lastActivityAt = Date.now();
      this.userRoom.set(user.id, room.code);

      this.emitter.toRoom(room.code, 'player-joined', { playerId: user.id, nickname: user.nickname, seat });
      this.emitter.toRoom(room.code, 'room-updated', this.publicRoom(room));
      return { roomCode: room.code, room: this.publicRoom(room), rejoined: false };
    }));
  }

  leaveRoom(user) {
    return this.queue.run(`user:${user.id}`, async () => {
      const code = this.userRoom.get(user.id);
      if (!code) return { left: false };
      return this.queue.run(`room:${code}`, async () => {
        const room = this.rooms.get(code);
        if (!room) {
          this.userRoom.delete(user.id);
          return { left: false };
        }
        if (room.status === 'in_progress') throw appError('GAME_IN_PROGRESS');
        if (room.status !== 'waiting') {
          this.userRoom.delete(user.id); // finished or abandoned: just let go of it
          return { left: true, roomCode: code };
        }

        const leaving = room.players.find((p) => p.userId === user.id);
        const remaining = room.players.filter((p) => p.userId !== user.id);
        if (remaining.length === 0) {
          await this.persistence.abandon({ roomId: room.id, sessionId: null });
          room.status = 'abandoned';
          this.rooms.delete(code);
        } else {
          const newHost = room.hostUserId === user.id ? remaining.slice().sort((a, b) => a.seat - b.seat)[0].userId : room.hostUserId;
          await this.db.withTransaction(async (tx) => {
            await roomsRepo.deleteRoomPlayer(tx, { roomId: room.id, userId: user.id });
            if (newHost !== room.hostUserId) await roomsRepo.setHost(tx, { roomId: room.id, hostUserId: newHost });
          });
          room.players = remaining;
          room.hostUserId = newHost;
        }
        this.userRoom.delete(user.id);
        if (leaving) {
          this.emitter.toRoom(code, 'player-left', { playerId: user.id, reason: 'left' });
          if (remaining.length > 0) this.emitter.toRoom(code, 'room-updated', this.publicRoom(room));
        }
        return { left: true, roomCode: code };
      });
    });
  }

  startGame(user) {
    const code = this.userRoom.get(user.id);
    if (!code) return Promise.reject(appError('NOT_IN_ROOM'));
    return this.queue.run(`room:${code}`, async () => {
      const room = this.rooms.get(code);
      if (!room) throw appError('ROOM_NOT_FOUND');
      if (room.hostUserId !== user.id) throw appError('NOT_HOST');
      if (room.status !== 'waiting') throw appError('ROOM_STARTED');
      if (room.players.length < MIN_PLAYERS) throw appError('NOT_ENOUGH_PLAYERS');

      // From here the player list is frozen: join-room refuses a non-waiting room.
      await this.gameSessions.start(room);
      room.status = 'in_progress';
      room.lastActivityAt = Date.now();
      this.emitter.toRoom(code, 'room-updated', this.publicRoom(room));
      return { roomCode: code, room: this.publicRoom(room) };
    });
  }

  /** Everything a (re)connecting client needs to redraw. */
  resume(user, rawCode) {
    const code = this.userRoom.get(user.id);
    if (!code || (rawCode && rawCode !== code)) return Promise.reject(appError('NOT_IN_ROOM'));
    const room = this.rooms.get(code);
    if (!room) return Promise.reject(appError('ROOM_NOT_FOUND'));
    const view = this.gameSessions.has(code) ? this.gameSessions.viewFor(code, user.id) : null;
    return Promise.resolve({ roomCode: code, room: this.publicRoom(room), view });
  }

  // ---- presence ------------------------------------------------------------

  handleConnect(userId, socketId) {
    const first = this.presence.add(userId, socketId);
    const code = this.userRoom.get(userId);
    if (!code || !first) return code || null;
    const room = this.rooms.get(code);
    if (room) this.#markConnection(room, userId, true);
    return code;
  }

  handleDisconnect(userId, socketId) {
    const last = this.presence.remove(userId, socketId);
    if (!last) return;
    const code = this.userRoom.get(userId);
    const room = code && this.rooms.get(code);
    if (room) this.#markConnection(room, userId, false);
  }

  #markConnection(room, userId, connected) {
    if (this.stopped) return; // shutting down: sockets closing must not touch the database
    const player = room.players.find((p) => p.userId === userId);
    if (!player) return;
    room.lastActivityAt = Date.now();
    this.emitter.toRoom(room.code, connected ? 'player-reconnected' : 'player-disconnected', { playerId: userId });
    this.emitter.toRoom(room.code, 'room-updated', this.publicRoom(room));
    roomsRepo.setConnected(this.db, { roomPlayerId: player.roomPlayerId, isConnected: connected })
      .catch((err) => this.logger.warn('could not save connection state', { err }));
    if (this.gameSessions.has(room.code)) this.gameSessions.onPresenceChange(room.code);
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Rebuild rooms and live games from PostgreSQL after a restart. */
  async recover() {
    const [rooms, sessions] = await Promise.all([roomsRepo.loadOpenRooms(this.db), sessionsRepo.loadLiveSessions(this.db)]);
    const sessionByRoom = new Map(sessions.map((s) => [s.room_id, s]));
    let restored = 0;
    for (const row of rooms) {
      const room = {
        id: row.id,
        code: row.room_code,
        gameType: row.game_type,
        hostUserId: row.host_user_id,
        status: row.status,
        maxPlayers: row.max_players,
        sessionId: null,
        lastActivityAt: Date.now(),
        players: row.players.map((p) => ({
          userId: p.user_id, nickname: p.nickname, seat: p.seat_no, roomPlayerId: p.id, status: p.status,
        })),
      };
      this.rooms.set(room.code, room);
      for (const p of room.players) this.userRoom.set(p.userId, room.code);
      const session = sessionByRoom.get(row.id);
      if (row.status === 'in_progress') {
        if (session && session.state_snapshot) {
          this.gameSessions.restore(room, session);
          restored += 1;
        } else {
          this.logger.warn('in-progress room without a saved game, abandoning', { roomCode: room.code });
          await this.#abandon(room);
        }
      }
    }
    this.logger.info('recovery complete', { rooms: this.rooms.size, games: restored });
  }

  startSweeper(intervalMs = 60000) {
    this.sweeper = setInterval(() => this.sweepIdle().catch((err) => this.logger.error('sweep failed', { err })), intervalMs);
    this.sweeper.unref();
  }

  /** Abandon rooms that nobody has been connected to for a long time. */
  async sweepIdle(now = Date.now()) {
    if (!this.lastGuestPurge || now - this.lastGuestPurge > DAY_MS) {
      this.lastGuestPurge = now;
      await this.#dailyCleanup();
    }
    const limit = this.env.roomIdleMinutes * 60 * 1000;
    for (const room of [...this.rooms.values()]) {
      const anyoneHere = room.players.some((p) => this.presence.isConnected(p.userId));
      if (anyoneHere || now - room.lastActivityAt < limit) continue;
      await this.queue.run(`room:${room.code}`, () => (room.status === 'finished' ? this.#evict(room) : this.#abandon(room)));
    }
  }

  /** Old finished/abandoned rooms first (they release their players), then guests nobody refers to. */
  #dailyCleanup() {
    const days = this.env.dataRetentionDays;
    const oldRooms = days > 0 ? sessionsRepo.purgeOldRooms(this.db, days) : Promise.resolve(0);
    return oldRooms
      .then((n) => { if (n > 0) this.logger.info('old rooms removed', { count: n, olderThanDays: days }); })
      .then(() => usersRepo.purgeStaleGuests(this.db, GUEST_RETENTION_DAYS))
      .then((n) => { if (n > 0) this.logger.info('stale guests removed', { count: n }); })
      .catch((err) => this.logger.warn('data cleanup failed', { err }));
  }

  /** Forget a finished room (its results are already saved; nothing is rewritten). */
  #evict(room) {
    this.gameSessions.forget(room.code);
    this.rooms.delete(room.code);
    for (const p of room.players) if (this.userRoom.get(p.userId) === room.code) this.userRoom.delete(p.userId);
  }

  async #abandon(room) {
    await this.persistence.abandon({ roomId: room.id, sessionId: room.sessionId });
    this.gameSessions.forget(room.code);
    room.status = 'abandoned';
    this.rooms.delete(room.code);
    for (const p of room.players) if (this.userRoom.get(p.userId) === room.code) this.userRoom.delete(p.userId);
    this.emitter.toRoom(room.code, 'room-updated', this.publicRoom(room));
    this.logger.info('room abandoned', { roomCode: room.code });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.sweeper);
  }

  #onGameFinished(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.status = 'finished';
    for (const p of room.players) {
      const state = this.gameSessions.live.get(code)?.state;
      if (state && state.players[p.userId]) p.status = state.players[p.userId].status;
    }
    this.emitter.toRoom(code, 'room-updated', this.publicRoom(room));
  }

  /** A user may only be in one unfinished room; finished rooms are released automatically. */
  #assertFree(userId) {
    const code = this.userRoom.get(userId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room || room.status === 'finished' || room.status === 'abandoned') {
      this.userRoom.delete(userId);
      return;
    }
    throw appError('ALREADY_IN_ROOM', { roomCode: code });
  }
}

module.exports = { RoomService, MAX_PLAYERS, MIN_PLAYERS };
