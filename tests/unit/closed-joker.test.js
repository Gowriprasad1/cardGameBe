'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGame, canSeeJoker, hideJoker } = require('../../src/games/set/game-engine');
const { viewFor } = require('../../src/games/set/view');
const { resolveConfig } = require('../../src/games/set/set.config');
const { fairInput } = require('../../src/bots/bot-driver.service');
const {
  scenario, act, groupIds, seededRng, playersOf, setDrawTop,
} = require('../helpers/cards');

const CLOSED = { jokerMode: 'closed' };
// p1 has a LIFE (7777); p2 has none. The open joker is 5.
const HANDS = {
  p1: '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 2C',
  p2: '5H 3H 4H 6H JH QH KS 2D 3D 4D 6D JD QD',
};
const allCards = (view) => [...view.me.hand, view.round.discardTop, ...view.round.discards.map((e) => e.card)].filter(Boolean);

test('open joker is the default: everyone sees it', () => {
  assert.equal(resolveConfig({}).jokerMode, 'open');
  assert.throws(() => resolveConfig({ jokerMode: 'secret' }), { code: 'INVALID_CONFIG' });
  const state = scenario({ n: 2, openJoker: '5', hands: HANDS });
  const v = viewFor(state, 'p2');
  assert.equal(v.round.openJokerRank, '5');
  assert.equal(v.round.jokerHidden, false);
  assert.ok(v.me.hand.find((c) => c.id === 'D1-H-5').isOpenJoker);
});

test('closed joker: only a player with a LIFE sees the open joker', () => {
  const state = scenario({ n: 2, openJoker: '5', hands: HANDS, config: CLOSED, current: 'p1' });
  const { state: s, events } = act(state, { type: 'draw', playerId: 'p1', source: 'draw' });
  assert.equal(canSeeJoker(s, 'p1'), true);
  assert.equal(canSeeJoker(s, 'p2'), false);

  const mine = viewFor(s, 'p1');
  assert.equal(mine.round.openJokerRank, '5');
  assert.equal(mine.round.jokerHidden, false);
  assert.equal(mine.config.jokerMode, 'closed');

  const theirs = viewFor(s, 'p2');
  assert.equal(theirs.round.openJokerRank, null);
  assert.equal(theirs.round.openJokerCard, null);
  assert.equal(theirs.round.jokerHidden, true);
  assert.ok(allCards(theirs).every((c) => c.isOpenJoker === false), 'no card gives the joker away');

  const told = events.filter((e) => e.name === 'joker-revealed');
  assert.deepEqual(told.map((e) => e.to), ['p1'], 'only p1 is told, privately');
  assert.equal(told[0].payload.openJokerRank, '5');
});

test('closed joker: a player who gets a LIFE later sees it from then on, even after breaking the LIFE', () => {
  const hands = { p1: '7H 7D 7C 8H 8D 8C 9H 9D 9C 10H 10D 2C 3S', p2: HANDS.p2 };
  let s = scenario({ n: 2, openJoker: '5', hands, config: CLOSED, current: 'p1' });
  s = act(s, { type: 'arrange', playerId: 'p1', groups: s.round.groups.p1 }).state;
  assert.equal(canSeeJoker(s, 'p1'), false, 'three 7s are not a LIFE yet');
  setDrawTop(s, '7S');
  const drawn = act(s, { type: 'draw', playerId: 'p1', source: 'draw' });
  assert.equal(canSeeJoker(drawn.state, 'p1'), true);
  assert.ok(drawn.events.some((e) => e.name === 'joker-revealed' && e.to === 'p1'));
  // throwing one of the 7s breaks the LIFE, but what p1 has seen stays seen
  const after = act(drawn.state, { type: 'discard', playerId: 'p1', cardId: 'D1-H-7' });
  assert.equal(canSeeJoker(after.state, 'p1'), true);
  assert.equal(after.events.filter((e) => e.name === 'joker-revealed').length, 0, 'told only once');
});

test('closed joker: a player dealt a LIFE sees it from the start', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { state, events } = createGame({ players: playersOf(4), config: CLOSED, rng: seededRng(seed) });
    for (const id of state.seatOrder) {
      const counts = {};
      for (const c of state.round.hands[id]) if (!c.joker) counts[c.rank] = (counts[c.rank] || 0) + 1;
      const life = Object.values(counts).some((n) => n >= 4);
      assert.equal(canSeeJoker(state, id), life, `seed ${seed} ${id}`);
      assert.equal(events.some((e) => e.name === 'joker-revealed' && e.to === id), life);
    }
  }
});

test('closed joker: once somebody declares, everyone sees it', () => {
  const hands = { p1: '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C', p2: HANDS.p2 };
  const state = scenario({ n: 2, openJoker: '5', hands, config: { ...CLOSED, showWindowSeconds: 30 }, current: 'p1' });
  const groups = groupIds(['7H 7D 7C 7S', '8H 8D 8C', '9H 9D 9C', '10H 10D 10C']);
  const { state: s } = act(state, { type: 'declare', playerId: 'p1', groups });
  assert.equal(s.round.phase, 'showing');
  assert.equal(viewFor(s, 'p2').round.openJokerRank, '5');
  const done = act(s, { type: 'submit-show', playerId: 'p2' }).state;
  assert.equal(viewFor(done, 'p2').round.openJokerRank, '5');
});

test('closed joker: mawa is not told the joker before it has a LIFE', () => {
  const state = scenario({ n: 2, openJoker: '5', hands: HANDS, config: CLOSED, current: 'p1' });
  const s = act(state, { type: 'arrange', playerId: 'p1', groups: state.round.groups.p1 }).state;
  assert.equal(fairInput(s, 'p2').openJokerRank, null);
  assert.equal(fairInput(s, 'p1').openJokerRank, '5');
});

test('hideJoker strips the rank, the card and every joker flag from an event', () => {
  const payload = {
    openJokerRank: '5',
    openJokerCard: { id: 'D1-S-5', isOpenJoker: true },
    discardTop: { id: 'D1-H-5', isOpenJoker: true },
    cards: [{ id: 'D1-D-5', isOpenJoker: true }, { id: 'D1-D-6', isOpenJoker: false }],
  };
  const hidden = hideJoker(payload);
  assert.equal(hidden.openJokerRank, null);
  assert.equal(hidden.openJokerCard, null);
  assert.equal(hidden.discardTop.isOpenJoker, false);
  assert.ok(hidden.cards.every((c) => c.isOpenJoker === false));
  assert.equal(payload.discardTop.isOpenJoker, true, 'the original is not changed');
});
