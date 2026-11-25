'use strict';

const { Server } = require('socket.io');
const { appError, toPublicError } = require('../constants/errors');
const { validate } = require('../validators/schema');
const schemas = require('../validators/payloads');

/** Token bucket: each socket may burst a little, then is limited to a steady rate. */
function createBucket({ capacity = 20, refillPerSecond = 8, now = Date.now } = {}) {
  let tokens = capacity;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSecond);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * Attach Socket.IO to an HTTP server.
 *
 * Handlers are deliberately thin: authenticate (done once at the handshake),
 * rate-limit, validate the payload, call ONE service method, acknowledge.
 * Identity always comes from the authenticated socket, never from the payload,
 * and the room is always the one the server knows the user is in.
 */
function attachSocket(httpServer, container) {
  const { env, logger, users, rooms, gameSessions, emitter, presence } = container;

  const io = new Server(httpServer, {
    cors: { origin: env.clientOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 20 * 1024,
    serveClient: false,
    pingInterval: 10000,
    pingTimeout: 8000,
  });
  emitter.bind(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const user = await users.authenticate(token);
      if (!user) return next(Object.assign(new Error('UNAUTHENTICATED'), { data: { code: 'UNAUTHENTICATED' } }));
      socket.data.user = user;
      return next();
    } catch (err) {
      logger.error('socket auth failed', { err });
      return next(Object.assign(new Error('INTERNAL'), { data: { code: 'INTERNAL' } }));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    const log = logger.child({ socketId: socket.id, userId: user.id });
    const allow = createBucket({ capacity: env.socketBurst, refillPerSecond: env.socketRatePerSecond });

    socket.join(`user:${user.id}`);
    const roomCode = rooms.handleConnect(user.id, socket.id);
    if (roomCode) socket.join(`room:${roomCode}`);
    log.info('socket connected', { roomCode });

    /**
     * Register an event with the standard pipeline and acknowledgement shape:
     *   { ok: true, data } | { ok: false, error: { code, message } }
     */
    const on = (event, schema, handler) => {
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (!allow()) throw appError('RATE_LIMITED');
          const data = validate(schema, payload);
          const result = await handler(data);
          reply({ ok: true, data: result || {} });
        } catch (err) {
          const { body, expected } = toPublicError(err);
          if (expected) log.debug('event rejected', { event, code: body.code });
          else log.error('event failed', { event, err });
          reply({ ok: false, error: body });
        }
      });
    };

    const currentRoom = () => {
      const code = rooms.activeRoomCode(user.id);
      if (!code) throw appError('NOT_IN_ROOM');
      return code;
    };
    const game = (action, requestId) => gameSessions.perform(currentRoom(), user.id, action, requestId);

    // ---- room ----
    on('create-room', schemas.createRoom, async ({ gameType }) => {
      const result = await rooms.createRoom(user, gameType);
      socket.join(`room:${result.roomCode}`);
      return result;
    });

    on('join-room', schemas.joinRoom, async ({ roomCode: code }) => {
      const result = await rooms.joinRoom(user, code);
      socket.join(`room:${result.roomCode}`);
      return result;
    });

    on('leave-room', schemas.empty, async () => {
      const code = rooms.activeRoomCode(user.id);
      const result = await rooms.leaveRoom(user);
      if (code && result.left) socket.leave(`room:${code}`);
      return result;
    });

    on('start-game', schemas.empty, () => rooms.startGame(user));

    on('resume', schemas.resume, async ({ roomCode: code }) => {
      const result = await rooms.resume(user, code);
      socket.join(`room:${result.roomCode}`);
      return result;
    });

    // ---- game ----
    on('draw-card', schemas.drawCard, ({ requestId, source }) => game({ type: 'draw', source }, requestId));
    on('discard-card', schemas.discardCard, ({ requestId, cardId, endTurn }) => (
      game({ type: 'discard', cardId, endTurn }, requestId)));
    on('end-turn', schemas.endTurn, ({ requestId }) => game({ type: 'end-turn' }, requestId));
    on('arrange-cards', schemas.arrangeCards, ({ requestId, groups }) => game({ type: 'arrange', groups }, requestId));
    on('declare-game', schemas.declareGame, ({ requestId, groups }) => game({ type: 'declare', groups }, requestId));
    on('player-drop', schemas.playerDrop, ({ requestId }) => game({ type: 'drop' }, requestId));
    on('one-card-to-win', schemas.oneCardToWin, ({ requestId, active }) => (
      game({ type: 'one-card-to-win', active }, requestId)));
    on('next-round-ready', schemas.empty, () => gameSessions.readyForNextRound(currentRoom(), user.id));

    socket.on('disconnect', (reason) => {
      rooms.handleDisconnect(user.id, socket.id);
      log.info('socket disconnected', { reason, stillConnected: presence.isConnected(user.id) });
    });
  });

  return io;
}

module.exports = { attachSocket, createBucket };
