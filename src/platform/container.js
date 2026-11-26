'use strict';

const { KeyedQueue } = require('../utils/keyed-queue');
const { createGameRegistry } = require('./game-registry');
const { Presence, Emitter } = require('./presence');
const { UserService } = require('./user.service');
const { GamePersistence } = require('./game-persistence.service');
const { GameSessionService } = require('./game-session.service');
const { RoomService } = require('./room.service');
const { BotDriver } = require('../bots/bot-driver.service');

/**
 * Wires the platform together. Nothing here knows about Express or Socket.IO;
 * the transport layers receive the container and call its services.
 *
 * @param {{env: object, db: object, logger: object, registry?: object}} deps
 */
function createContainer({ env, db, logger, registry = createGameRegistry() }) {
  const queue = new KeyedQueue();
  const presence = new Presence();
  const emitter = new Emitter();
  const persistence = new GamePersistence({ db, keepFullGameData: env.keepFullGameData });
  const users = new UserService({ db });
  const gameSessions = new GameSessionService({ registry, persistence, emitter, presence, queue, logger, env });
  const rooms = new RoomService({ db, registry, emitter, presence, gameSessions, persistence, queue, logger, env });
  // mawa, the computer player: plays through gameSessions like any person
  const bots = new BotDriver({ gameSessions, logger, env });
  gameSessions.onUpdate = (live) => bots.watch(live);

  return {
    env, db, logger, registry, queue, presence, emitter, users, gameSessions, rooms, bots,
    /** Load unfinished rooms and games from the database. Call once at startup. */
    async start() {
      await rooms.recover();
      rooms.startSweeper();
    },
    async stop() {
      rooms.stop();
      bots.stop();
      gameSessions.stop();
    },
  };
}

module.exports = { createContainer };
