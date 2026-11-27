'use strict';

/**
 * Whole-game simulations: bots play complete games (many rounds) against the
 * engine for 2, 3, 4 and 5 players. Bots only use what a real client sees
 * (their own `viewFor` projection) and talk to the engine through actions.
 *
 * Every action also passes the engine's own card-integrity check, so a missing
 * or duplicated card anywhere would fail these tests immediately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGame, applyAction } = require('../../src/games/set/game-engine');
const { viewFor } = require('../../src/games/set/view');
const { seededRng, playersOf, scenario, act } = require('../helpers/cards');

const { decideFromView } = require('../helpers/bot');

/** One bot decision for the active player, as an engine action. */
function decide(state, id, bot) {
  return { ...decideFromView(viewFor(state, id), bot), playerId: id };
}

function assertNoLeaks(state) {
  // a card picked up from the open pile was face up and everyone saw it taken: public, not a leak
  const takenOpenly = new Set((state.round.discardLog || []).filter((e) => e.takenBy).map((e) => e.card.id));
  for (const viewer of state.seatOrder) {
    const json = JSON.stringify(viewFor(state, viewer));
    for (const other of state.seatOrder) {
      if (other === viewer || !state.round.hands[other]) continue;
      for (const c of state.round.hands[other]) {
        if (takenOpenly.has(c.id)) continue;
        assert.ok(!json.includes(`"${c.id}"`), 'opponent card leaked');
      }
    }
    for (const c of state.round.drawPile) assert.ok(!json.includes(`"${c.id}"`), 'draw pile leaked');
  }
}

function playFullGame(playerCount, seed, botFor) {
  const rng = seededRng(seed);
  const created = createGame({ players: playersOf(playerCount), config: { turnTimerSeconds: 0 }, rng });
  let { state } = created;
  const publicEventNames = new Set(created.events.map((e) => e.name));
  let steps = 0;

  while (state.stage !== 'completed') {
    assert.ok(steps++ < 40000, 'game did not finish');
    if (state.stage === 'between-rounds') {
      const r = applyAction(state, { type: 'start-next-round' }, { rng });
      for (const e of r.events) publicEventNames.add(e.name);
      state = r.state;
      continue;
    }
    if (state.roundNo === 1) assertNoLeaks(state);
    const id = state.round.currentPlayerId;
    const action = decide(state, id, botFor(id));
    const r = applyAction(state, action, { rng });
    for (const e of r.events) publicEventNames.add(e.name);
    state = r.state;
  }
  return { state, publicEventNames };
}

function assertGameConsistent(state, playerCount) {
  assert.equal(state.stage, 'completed');
  assert.ok(state.winnerId, 'a winner is declared');
  assert.ok(state.history.length >= 1);
  assert.equal(state.history.length, state.roundNo);

  // cumulative scores are exactly the sum of per-round penalties (nothing double counted)
  for (const id of state.seatOrder) {
    const sum = state.history.reduce((s, round) => {
      const mine = round.results.find((r) => r.playerId === id);
      return s + (mine ? mine.penalty : 0);
    }, 0);
    assert.equal(state.players[id].score, sum, `score of ${id}`);
  }

  // a player has at most one penalty entry per round
  for (const round of state.history) {
    const seen = new Set(round.results.map((r) => r.playerId));
    assert.equal(seen.size, round.results.length);
  }

  // eliminated players are at or above 201; everyone else is below
  const eliminated = state.seatOrder.filter((id) => state.players[id].status === 'eliminated');
  for (const id of eliminated) assert.ok(state.players[id].score >= 201);
  const remaining = state.seatOrder.filter((id) => state.players[id].status === 'active');
  for (const id of remaining) assert.ok(state.players[id].score < 201);
  assert.ok(remaining.length <= 1, 'at most one eligible player remains');
  if (remaining.length === 1) {
    assert.equal(remaining[0], state.winnerId);
    assert.equal(eliminated.length, playerCount - 1);
  }
}

for (const n of [2, 3, 4, 5]) {
  test(`${n}-player game plays to a winner (bots, several rounds, real rules)`, () => {
    const bots = {
      cautious: { maxTurns: 14 },
      quitter: { maxTurns: 14, quitsFirst: true },
    };
    const { state, publicEventNames } = playFullGame(n, 1000 + n, (id) => (id === 'p1' ? bots.quitter : bots.cautious));
    assertGameConsistent(state, n);
    for (const name of ['game-started', 'dealer-selected', 'cards-distributed', 'hand-updated', 'player-turn',
      'card-drawn', 'card-discarded', 'player-drop', 'round-completed', 'scoreboard-updated', 'player-eliminated',
      'game-completed']) {
      assert.ok(publicEventNames.has(name), `no ${name} event during a whole game`);
    }
  });
}

test('several different seeds all finish cleanly', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const n = 2 + (seed % 4);
    const { state } = playFullGame(n, seed * 31, () => ({ maxTurns: 10 + (seed % 5) }));
    assertGameConsistent(state, n);
  }
});

// ---------------------------------------------------------------------------
// simultaneous actions: the platform serialises them, the engine must reject
// whichever comes second
// ---------------------------------------------------------------------------

test('simultaneous conflicting actions: the second one is rejected, the state stays consistent', () => {
  const state = scenario({ n: 4 });
  const first = state.round.currentPlayerId;
  const others = state.seatOrder.filter((id) => id !== first);

  // two players try to draw "at the same time"; the platform processes them one by one
  let s = act(state, { type: 'draw', playerId: first, source: 'draw' }).state;
  assert.throws(() => act(s, { type: 'draw', playerId: others[0], source: 'draw' }), (e) => e.code === 'NOT_YOUR_TURN');

  // the same player sends the same draw twice (double click)
  assert.throws(() => act(s, { type: 'draw', playerId: first, source: 'draw' }), (e) => e.code === 'ALREADY_DRAWN');

  // double discard
  s = act(s, { type: 'discard', playerId: first, cardId: s.round.lastDrawnId, endTurn: false }).state;
  assert.throws(() => act(s, { type: 'discard', playerId: first, cardId: s.round.hands[first][0].id }), (e) => e.code === 'ALREADY_DISCARDED');

  // a drop and a draw racing for the same turn
  const turn = act(s, { type: 'end-turn', playerId: first }).state;
  const p = turn.round.currentPlayerId;
  const dropped = act(turn, { type: 'drop', playerId: p }).state;
  assert.throws(() => act(dropped, { type: 'draw', playerId: p, source: 'draw' }), (e) => ['NOT_IN_ROUND', 'NOT_YOUR_TURN'].includes(e.code));
  assert.equal(dropped.round.penalties[p].penalty, 20, 'penalty applied exactly once');
});

// ---------------------------------------------------------------------------
// recovery: state is plain data, so a snapshot can restore a game
// ---------------------------------------------------------------------------

test('a JSON snapshot restores the game (crash recovery / reconnection)', () => {
  const rng = seededRng(5);
  let { state } = createGame({ players: playersOf(3), rng });
  for (let i = 0; i < 6; i += 1) {
    const id = state.round.currentPlayerId;
    state = applyAction(state, decide(state, id, { maxTurns: 99 }), { rng }).state;
  }
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(restored, state);
  for (const id of state.seatOrder) {
    assert.deepEqual(viewFor(restored, id), viewFor(state, id), 'a reconnecting player gets the identical view');
  }
  const id = restored.round.currentPlayerId;
  const next = applyAction(restored, decide(restored, id, { maxTurns: 99 }), { rng });
  assert.equal(next.state.version, state.version + 1);
});
