'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../helpers/server');
const { attachBot } = require('../helpers/socket-bot');
const { decideRummy } = require('../helpers/rummy-bot');

const FAST = { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000' };
const code = (res) => res && res.error && res.error.code;

test('nobody can call themselves "mawa": the name belongs to the computer player', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    for (const name of ['mawa', 'Mawa', ' MAWA ']) {
      const res = await srv.api('POST', '/api/guests', { body: { nickname: name } });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'NAME_RESERVED');
    }
  } finally {
    await srv.stop();
  }
});

for (const [gameType, decide] of [['SET', undefined], ['RUMMY', decideRummy]]) {
  test(`single player ${gameType}: a room with mawa starts at once and mawa plays a whole game to the end`, async () => {
    const srv = await startTestServer({ env: FAST });
    try {
      const me = await srv.player(`Solo ${gameType}`);
      const res = await me.client.emit('create-solo-room', { gameType, points: 101 });
      assert.equal(res.ok, true, JSON.stringify(res));
      const { roomCode, room } = res.data;
      assert.equal(room.status, 'in_progress', 'no waiting room: the game starts at once');
      const mawa = room.players.find((p) => p.isBot);
      assert.ok(mawa, 'mawa is seated');
      assert.equal(mawa.nickname, 'mawa');
      assert.equal(mawa.isConnected, true);
      assert.equal(room.players.length, 2);

      // the computer user is marked as such and cannot sign in (its token is never handed out)
      const row = (await srv.db.query('SELECT nickname, is_bot, token_hash FROM users WHERE id = $1', [mawa.playerId])).rows[0];
      assert.deepEqual([row.nickname, row.is_bot], ['mawa', true]);
      assert.ok(row.token_hash.startsWith('bot:'));

      // a scripted stand-in plays my seat; mawa plays itself
      attachBot(me.client, { maxTurns: 6, quitsFirst: false }, decide);
      me.client.socket.emit('resume', {}, () => {});
      const state0 = me.client.lastState();
      if (state0) me.client.socket.listeners('game-state').forEach((fn) => fn(state0));
      const done = await me.client.waitFor('game-completed', { timeout: 150000 });
      assert.equal(me.client.botError, undefined, me.client.botError && me.client.botError.message);
      assert.ok(done.payload.totalRounds >= 1);

      // mawa really played: it drew, discarded or dropped on its own
      const live = srv.container.gameSessions.live.get(roomCode);
      const mawaRounds = live.state.history.flatMap((r) => r.results).filter((r) => r.playerId === mawa.playerId);
      assert.ok(mawaRounds.length >= 1);
      assert.ok(live.state.history.some((r) => r.results.some((x) => x.playerId === mawa.playerId && x.reason !== 'no_penalty')),
        'mawa took part in the scoring');
    } finally {
      await srv.stop();
    }
  });
}
