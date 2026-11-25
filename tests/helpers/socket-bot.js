'use strict';
const { rid } = require('./client');
const { decideFromView } = require('./bot');

const EVENT_FOR = {
  draw: ['draw-card', (a) => ({ source: a.source })],
  discard: ['discard-card', (a) => ({ cardId: a.cardId, endTurn: a.endTurn })],
  'end-turn': ['end-turn', () => ({})],
  declare: ['declare-game', (a) => ({ groups: a.groups })],
  drop: ['player-drop', () => ({})],
};

/** Make a client play like `bot` until the game is over. */
function attachBot(client, bot, decide = decideFromView) {
  let acting = false;
  let pending = null;
  let readyForRound = 0;

  const step = async (view) => {
    let v = view;
    if (v.stage === 'between-rounds' && readyForRound !== v.roundNo) {
      readyForRound = v.roundNo;
      await client.emit('next-round-ready', {});
      return;
    }
    let guard = 0;
    while (v.stage === 'in-round' && v.me && v.me.isMyTurn && guard++ < 6) {
      const action = decide(v, bot);
      const [event, pick] = EVENT_FOR[action.type];
      const res = await client.emit(event, { ...pick(action), requestId: rid() });
      if (!res.ok) throw new Error(`${event} refused: ${JSON.stringify(res.error)}`);
      v = res.data.view;
      if (['declare', 'drop', 'end-turn'].includes(action.type)) break;
      if (action.type === 'discard' && action.endTurn !== false) break;
    }
  };

  // Always act on the newest view: states that arrive while the bot is busy are not lost.
  const react = async (view) => {
    pending = view;
    if (acting) return;
    acting = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        await step(next);
      }
    } finally {
      acting = false;
    }
  };
  client.socket.on('game-state', (view) => {
    react(view).catch((err) => { client.botError = client.botError || err; });
  });
}


module.exports = { attachBot };
