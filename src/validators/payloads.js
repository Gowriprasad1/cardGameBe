'use strict';

/** Payload schemas for REST bodies and Socket.IO events. */

const requestId = { type: 'string', min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ };
const roomCode = { type: 'string', min: 4, max: 8, upper: true, pattern: /^[A-Z0-9]+$/ };
const cardId = { type: 'string', max: 12, pattern: /^D[12]-(?:[HDCS]-(?:A|[2-9]|10|J|Q|K)|JK-[12])$/ };
const groups = { type: 'array', max: 14, items: { type: 'array', max: 14, items: cardId } };

module.exports = {
  createGuest: {
    nickname: { type: 'string', min: 2, max: 30, pattern: /^[\p{L}\p{N} _.'-]+$/u },
  },
  createRoom: {
    gameType: { type: 'enum', values: ['SET', 'RUMMY'], default: 'SET' },
    // points at which a player is out; the host picks one when creating the room
    points: { type: 'enum', values: [101, 201, 301], default: 201 },
  },
  joinRoom: { roomCode },
  resume: { roomCode: { ...roomCode, optional: true } },
  empty: {},
  drawCard: { requestId, source: { type: 'enum', values: ['draw', 'discard'] } },
  discardCard: { requestId, cardId, endTurn: { type: 'boolean', optional: true } },
  endTurn: { requestId },
  arrangeCards: { requestId, groups },
  declareGame: { requestId, groups },
  playerDrop: { requestId },
  oneCardToWin: { requestId, active: { type: 'boolean', default: true } },
  roomCodeParam: { code: roomCode },
};
