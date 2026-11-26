'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const brain = require('../../src/bots/mawa-brain');
const { fairInput, taskFor, BOT_NAME } = require('../../src/bots/bot-driver.service');
const setRules = require('../../src/games/set/set-rules');
const rummyRules = require('../../src/games/rummy/rummy-rules');
const { cards, scenario, card } = require('../helpers/cards');

const base = (game, hand, extra = {}) => ({
  game,
  config: (game === 'RUMMY' ? rummyRules : setRules).resolveConfig({}),
  openJokerRank: 'K',
  deckCount: 2,
  hand: cards(hand),
  top: null,
  topPickable: false,
  turnsTaken: 1,
  myScore: 0,
  oneCardToWinFeature: game === 'SET',
  random: () => 0.5,
  ...extra,
});

test('the computer player is called "mawa"', () => {
  assert.equal(BOT_NAME, 'mawa');
});

test('SET: mawa declares a complete hand at once', () => {
  const t = base('SET', '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 10C');
  const move = brain.decideTurnStart(t);
  assert.equal(move.type, 'declare');
  assert.equal(setRules.validateDeclaration({ hand: t.hand, groups: move.groups, ctx: { config: t.config, openJokerRank: 'K' } }).valid, true);
});

test('SET: mawa takes the open card only when it clearly helps, then throws the useless card and declares', () => {
  const hand = '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C 10H 10D 2C';
  const useful = brain.decideTurnStart(base('SET', hand, { top: card('10C'), topPickable: true }));
  assert.deepEqual(useful, { type: 'draw', source: 'discard' });
  const useless = brain.decideTurnStart(base('SET', hand, { top: card('4S'), topPickable: true }));
  assert.deepEqual(useless, { type: 'draw', source: 'draw' }, 'a card that does not help is left on the pile');
  const after = brain.decideDiscard(base('SET', `${hand} 10C`));
  assert.equal(after.cardId, 'D1-C-2');
  assert.ok(after.declareGroups, 'the rest is a winning hand');
});

test('SET: mawa keeps pairs and jokers and throws the loose high card', () => {
  const after = brain.decideDiscard(base('SET', '7H 7D 7C 7S 8H 8D 8C 9H 9D 4C 4S QH JK1 2D'));
  assert.equal(after.cardId, 'D1-H-Q', 'the lonely queen goes; pairs (9 9, 4 4) and the joker stay');
  assert.equal(after.declareGroups, null);
});

test('SET: mawa presses 1 CARD TO WIN when its hand is waiting for one card', () => {
  // LIFE 7777, 888, 999, and K K waiting for a third K (K is not the joker here)
  const after = brain.decideDiscard(base('SET', '7H 7D 7C 7S 8H 8D 8C 9H 9D 9C KH KD 2S 3S', { openJokerRank: 'A' }));
  assert.equal(after.oneCardToWin, true);
});

test('mawa drops a hopeless first hand now and then, but never when the drop itself would put it out', () => {
  const awful = '2H 4D 6C 8S 10H QD AC 3S 5H 7D 9C JS KD';
  const t = base('SET', awful, { turnsTaken: 0, openJokerRank: 'A', random: () => 0.1 });
  assert.deepEqual(brain.decideTurnStart(t), { type: 'drop' });
  assert.equal(brain.decideTurnStart({ ...t, random: () => 0.9 }).type, 'draw', 'not every time');
  assert.equal(brain.decideTurnStart({ ...t, myScore: 190 }).type, 'draw', 'a drop to 210 would eliminate it');
  assert.equal(brain.decideTurnStart({ ...t, turnsTaken: 2 }).type, 'draw', 'later in the round it plays on');
});

test('Rummy: mawa declares a valid hand and builds towards a pure sequence', () => {
  const win = base('RUMMY', '4H 5H 6H 7S 8S 9S 9D 9C 9H 2D 2C 2S 2H', { openJokerRank: 'K' });
  assert.equal(brain.decideTurnStart(win).type, 'declare');
  const after = brain.decideDiscard(base('RUMMY', '4H 5H 6H 7S 8S 9D 9C 2D 2C 2S QH JC 3D KS', { openJokerRank: 'A' }));
  assert.ok(['D1-H-Q', 'D1-C-J', 'D1-D-3', 'D1-S-K'].includes(after.cardId), `threw ${after.cardId}: a loose card, not part of a run or set`);
});

test('fairness: mawa is given its own cards and the public table, never anyone else\'s cards or the closed pile', () => {
  const state = scenario({ n: 3, current: 'p2' });
  const input = fairInput(state, 'p2');
  assert.deepEqual(Object.keys(input).sort(), [
    'config', 'deckCount', 'game', 'hand', 'myScore', 'oneCardToWinFeature', 'openJokerRank', 'top', 'topPickable', 'turnsTaken',
  ]);
  assert.deepEqual(input.hand.map((c) => c.id), state.round.hands.p2.map((c) => c.id));
  const others = new Set([...state.round.hands.p1, ...state.round.hands.p3, ...state.round.drawPile].map((c) => c.id));
  const seen = JSON.stringify(input);
  for (const id of others) assert.ok(!seen.includes(`"${id}"`), `mawa must not see ${id}`);
});

test('mawa only moves when it is its turn (or it has to submit after a show)', () => {
  const state = scenario({ n: 2, current: 'p1' });
  assert.equal(taskFor(state, 'p1'), 'turn-start');
  assert.equal(taskFor(state, 'p2'), null);
  state.round.phase = 'awaiting-discard';
  assert.equal(taskFor(state, 'p1'), 'discard');
});

test('after a show mawa submits every one of its cards, jokers included (a SET hand with no LIFE and loose cards)', () => {
  const t = base('SET', '2H 2D 2C 4H 4D 4C 6H 6D 6C 5H 5D JK1 JK2', { openJokerRank: 'A' });
  const groups = brain.arrange(t, t.hand);
  assert.deepEqual(groups.flat().sort(), t.hand.map((c) => c.id).sort(), 'every card exactly once');
  assert.ok(groups.flat().includes('D1-JK-1') && groups.flat().includes('D1-JK-2'));
});
