'use strict';

/**
 * Test helpers: card shorthand, a seeded RNG, and a way to "rig" a game so a
 * scenario can be set up without breaking card integrity (cards are swapped,
 * never invented).
 *
 * Card tokens: `7H` = seven of hearts (deck 1), `10D/2` = ten of diamonds deck 2,
 *              `JK1` / `JK2` = printed jokers of deck 1, `JK1/2` = deck 2.
 */

const { resolveConfig } = require('../../src/games/set/set.config');
const setModule = require('../../src/games/set');
const rummyModule = require('../../src/games/rummy');

const MODULES = { SET: setModule, RUMMY: rummyModule };

const CARD_RE = /^(A|[2-9]|10|J|Q|K)([HDCS])(?:\/([12]))?$/;
const JOKER_RE = /^JK([12])(?:\/([12]))?$/;

function card(token) {
  let m = CARD_RE.exec(token);
  if (m) {
    const deck = Number(m[3] || 1);
    return { id: `D${deck}-${m[2]}-${m[1]}`, deck, suit: m[2], rank: m[1], joker: false };
  }
  m = JOKER_RE.exec(token);
  if (m) {
    const deck = Number(m[2] || 1);
    return { id: `D${deck}-JK-${m[1]}`, deck, suit: null, rank: null, joker: true };
  }
  throw new Error(`Bad card token: ${token}`);
}

/** 'a b c' -> card objects */
function cards(str) {
  return str.trim().split(/\s+/).map(card);
}

/** 'a b c' -> card ids */
function ids(str) {
  return cards(str).map((c) => c.id);
}

/** ['7H 7D 7C', '8H 8D 8C'] -> [[ids], [ids]] */
function groupIds(list) {
  return list.map(ids);
}

function ctx(openJokerRank = 'A', overrides = {}) {
  return { config: resolveConfig(overrides), openJokerRank };
}

/** Deterministic rng with the same signature as secureRandomInt. */
function seededRng(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * n);
  };
}

function playersOf(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, nickname: `Player ${i + 1}` }));
}

function findCard(state, id) {
  const r = state.round;
  const zones = [r.drawPile, r.discardPile, ...Object.values(r.hands)];
  for (const zone of zones) {
    const index = zone.findIndex((c) => c.id === id);
    if (index !== -1) return { zone, index };
  }
  throw new Error(`card ${id} not found`);
}

/** Make `rank` the open joker rank by swapping the revealed card for one of that rank. */
function setOpenJoker(state, rank) {
  const r = state.round;
  if (r.openJokerRank === rank) return;
  const { zone, index } = (() => {
    for (const zone of [r.drawPile, r.discardPile, ...Object.values(r.hands)]) {
      const index = zone.findIndex((c) => !c.joker && c.rank === rank);
      if (index !== -1) return { zone, index };
    }
    throw new Error(`no card of rank ${rank}`);
  })();
  [zone[index], r.openJokerCard] = [r.openJokerCard, zone[index]];
  r.openJokerRank = rank;
}

/**
 * Give players exactly the listed cards by swapping with wherever those cards
 * currently are. `hands` = { p1: '7H 7D ...', p2: '...' }. Card sets must not overlap.
 */
function rigHands(state, hands) {
  const round = state.round;
  const wantedAll = new Set();
  for (const [playerId, str] of Object.entries(hands)) {
    const wanted = cards(str);
    if (wanted.length !== round.hands[playerId].length) {
      throw new Error(`${playerId} needs ${round.hands[playerId].length} cards, got ${wanted.length}`);
    }
    for (const c of wanted) {
      if (wantedAll.has(c.id)) throw new Error(`card ${c.id} requested twice`);
      wantedAll.add(c.id);
    }
  }
  // If the face-up joker card is one we want, swap it for another card of the same rank first.
  if (wantedAll.has(round.openJokerCard.id)) {
    const rank = round.openJokerCard.rank;
    const zones = [round.drawPile, round.discardPile, ...Object.values(round.hands)];
    for (const zone of zones) {
      const index = zone.findIndex((c) => c.rank === rank && !c.joker && !wantedAll.has(c.id));
      if (index !== -1) {
        [zone[index], round.openJokerCard] = [round.openJokerCard, zone[index]];
        break;
      }
    }
    if (wantedAll.has(round.openJokerCard.id)) throw new Error(`card ${round.openJokerCard.id} is the open joker card`);
  }
  for (const [playerId, str] of Object.entries(hands)) {
    const hand = round.hands[playerId];
    const wanted = cards(str);
    const wantedIds = new Set(wanted.map((c) => c.id));
    for (const w of wanted) {
      if (hand.some((c) => c.id === w.id)) continue;
      const { zone, index } = findCard(state, w.id);
      const handIndex = hand.findIndex((c) => !wantedIds.has(c.id));
      [zone[index], hand[handIndex]] = [hand[handIndex], zone[index]];
    }
    round.groups[playerId] = hand.map((c) => [c.id]);
  }
}

/** Put a specific card on top of the draw pile (swap with the current top). */
function setDrawTop(state, token) {
  const target = card(token);
  const r = state.round;
  const { zone, index } = findCard(state, target.id);
  const topIndex = r.drawPile.length - 1;
  [zone[index], r.drawPile[topIndex]] = [r.drawPile[topIndex], zone[index]];
}

/** Put a specific card on top of the open (discard) pile, swapping with the current top. */
function setDiscardTop(state, token) {
  const target = card(token);
  const r = state.round;
  const topIndex = r.discardPile.length - 1;
  const { zone, index } = findCard(state, target.id);
  [zone[index], r.discardPile[topIndex]] = [r.discardPile[topIndex], zone[index]];
}

/**
 * Start an n-player game with deterministic randomness and optional rigging.
 * @returns {object} engine state
 */
function scenario({ n = 3, seed = 7, config = {}, openJoker = 'A', hands = {}, current, game = 'SET' } = {}) {
  const { state } = MODULES[game].createGame({ players: playersOf(n), config, rng: seededRng(seed) });
  const s = structuredClone(state);
  setOpenJoker(s, openJoker);
  rigHands(s, hands);
  if (current) s.round.currentPlayerId = current;
  return s;
}

/** Apply an action and return only the new state (events via the second return). */
function act(state, action, rng = seededRng(99)) {
  return MODULES[state.game || 'SET'].applyAction(state, action, { rng });
}

/** Draw (from the closed pile) then discard `cardId`, ending the turn. */
function playTurn(state, playerId, discardId, rng) {
  let r = act(state, { type: 'draw', playerId, source: 'draw' }, rng);
  r = act(r.state, { type: 'discard', playerId, cardId: discardId }, rng);
  return r;
}

module.exports = {
  card, cards, ids, groupIds, ctx, seededRng, playersOf, scenario, rigHands, setOpenJoker, setDrawTop, setDiscardTop, act, playTurn,
};
