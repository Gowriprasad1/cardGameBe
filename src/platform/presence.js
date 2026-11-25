'use strict';

/** Which users currently have at least one live socket. */
class Presence {
  constructor() {
    this.sockets = new Map(); // userId -> Set(socketId)
  }

  /** @returns {boolean} true if this is the user's first connection */
  add(userId, socketId) {
    const set = this.sockets.get(userId) || new Set();
    const first = set.size === 0;
    set.add(socketId);
    this.sockets.set(userId, set);
    return first;
  }

  /** @returns {boolean} true if that was the user's last connection */
  remove(userId, socketId) {
    const set = this.sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(userId);
      return true;
    }
    return false;
  }

  isConnected(userId) {
    return this.sockets.has(userId);
  }
}

/** Delivers events to Socket.IO channels. Does nothing until bound to a server. */
class Emitter {
  constructor() {
    this.io = null;
  }

  bind(io) {
    this.io = io;
  }

  toRoom(roomCode, name, payload) {
    if (this.io) this.io.to(`room:${roomCode}`).emit(name, payload);
  }

  toUser(userId, name, payload) {
    if (this.io) this.io.to(`user:${userId}`).emit(name, payload);
  }
}

module.exports = { Presence, Emitter };
