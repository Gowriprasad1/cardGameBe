'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../helpers/server');

const FAST = { TURN_TIMER_SECONDS: '0', SOCKET_BURST: '1000', SOCKET_RATE_PER_SECOND: '1000', BOT_DELAY_SCALE: '0' };

test('closed joker room: the setting is kept, and a player without a LIFE never receives the joker', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const me = await srv.player('Closed');
    const res = await me.client.emit('create-solo-room', { gameType: 'SET', points: 101, jokerMode: 'closed' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.room.jokerMode, 'closed');
    const live = srv.container.gameSessions.live.get(res.data.roomCode);
    assert.equal(live.state.config.jokerMode, 'closed');

    await me.client.waitFor('game-state');
    const view = me.client.lastState();
    const seen = Boolean(live.state.round.jokerSeen[me.userId]);
    assert.equal(view.round.jokerHidden, !seen);
    if (!seen) {
      assert.equal(view.round.openJokerRank, null);
      for (const name of ['cards-distributed', 'hand-updated']) {
        const text = JSON.stringify(me.client.all(name));
        assert.ok(!text.includes('"isOpenJoker":true'), `${name} gives the joker away`);
        assert.ok(!/"openJokerRank":"/.test(text), `${name} names the joker`);
      }
    }
  } finally {
    await srv.stop();
  }
});

test('Rummy rooms always show the wild joker, whatever is asked', async () => {
  const srv = await startTestServer({ env: FAST });
  try {
    const me = await srv.player('RumOpen');
    const res = await me.client.emit('create-room', { gameType: 'RUMMY', points: 101, jokerMode: 'closed' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.room.jokerMode, 'open');
  } finally {
    await srv.stop();
  }
});
