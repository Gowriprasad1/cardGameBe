'use strict';

const users = require('../db/repositories/users.repository');
const { generateToken, hashToken } = require('../utils/ids');

/** Guest identity: a nickname plus an opaque token kept in the browser. */
class UserService {
  constructor({ db }) {
    this.db = db;
  }

  async createGuest(nickname) {
    const token = generateToken();
    const user = await users.insertGuest(this.db, { nickname, tokenHash: hashToken(token) });
    return { userId: user.id, nickname: user.nickname, token };
  }

  /** @returns {Promise<{id: string, nickname: string}|null>} */
  async authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const user = await users.findByTokenHash(this.db, hashToken(token));
    if (user) users.touch(this.db, user.id).catch(() => {});
    return user;
  }
}

module.exports = { UserService };
