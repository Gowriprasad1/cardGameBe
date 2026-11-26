'use strict';

/**
 * The thinking of "mawa", the computer player. Pure functions: they get ONLY
 * what a human player in that seat can see:
 *   - mawa's own cards,
 *   - the top card of the open pile (and whether it can be taken),
 *   - the face-up joker number, the game settings, the number of decks,
 *   - mawa's own score and how many turns it has played this round.
 * Never anybody else's cards, never the closed pile. So mawa has no advantage:
 * it plays with exactly the information a person at the table has, through
 * the same server rules and the same turn timer.
 *
 * It plays like a sensible person: it keeps pairs and near-sequences, takes
 * the open card only when it clearly helps, throws away the card that hurts
 * its hand most, drops a hopeless first hand now and then, declares as soon as
 * its hand is complete, and (in SET) presses 1 CARD TO WIN when it can.
 */

const RULES = {
  SET: require('../games/set/set-rules'),
  RUMMY: require('../games/rummy/rummy-rules'),
};
const { cardPoints: setPoints } = require('../games/set/card-values');
const { cardPoints: rummyPoints } = require('../games/rummy/melds');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function rulesOf(game) {
  const rules = RULES[game];
  if (!rules) throw new Error(`mawa does not know the game ${game}`);
  return rules;
}

const ctxOf = ({ config, openJokerRank }) => ({ config, openJokerRank });
/** For judging hands the Rummy cap (80) is lifted, so a bad hand and a terrible one still differ. */
const judgeCtxOf = (t) => ({ config: { ...t.config, maxRoundPenalty: t.game === 'RUMMY' ? Number.MAX_SAFE_INTEGER : t.config.maxRoundPenalty }, openJokerRank: t.openJokerRank });

const isWild = (card, openJokerRank) => card.joker || card.rank === openJokerRank;
const points = (t, card) => (t.game === 'RUMMY' ? rummyPoints(card, ctxOf(t)) : setPoints(card, ctxOf(t)));

/** Loose cards that already have a partner (a pair, or in Rummy a same-suit card close by). */
function nearlyMatched(t, cards) {
  const naturals = cards.filter((c) => !isWild(c, t.openJokerRank));
  let count = 0;
  for (const c of naturals) {
    const partner = naturals.some((o) => o !== c && (o.rank === c.rank && (t.game !== 'RUMMY' || o.suit !== c.suit)
      || (t.game === 'RUMMY' && o.suit === c.suit && Math.abs(RANKS.indexOf(o.rank) - RANKS.indexOf(c.rank)) <= 2)));
    if (partner) count += 1;
  }
  return count;
}

/** How bad a 13-card hand is (lower is better): its points if someone declared now, minus a bonus for promising loose cards. */
function judge(t, hand) {
  const scored = rulesOf(t.game).scoreHand(hand, judgeCtxOf(t));
  const byId = new Map(hand.map((c) => [c.id, c]));
  const loose = scored.unmatchedIds.map((id) => byId.get(id)).filter(Boolean);
  return scored.points - 4 * nearlyMatched(t, loose);
}

/** The groups to declare with, if this 13-card hand is a winning hand; otherwise null. */
function winningGroups(t, hand) {
  const rules = rulesOf(t.game);
  const scored = rules.scoreHand(hand, ctxOf(t));
  if (scored.unmatchedIds.length > 0) return null;
  const groups = scored.groups.map((g) => g.cardIds);
  return rules.validateDeclaration({ hand, groups, ctx: ctxOf(t) }).valid ? groups : null;
}

/**
 * A tidy layout of the hand: its best groups, then every other card on its own.
 * Always every card exactly once (the scorer leaves out jokers that count 0, so
 * the rest is worked out from the hand itself).
 */
function arrange(t, hand) {
  const scored = rulesOf(t.game).scoreHand(hand, ctxOf(t));
  const groups = scored.groups.map((g) => g.cardIds);
  const placed = new Set(groups.flat());
  return [...groups, ...hand.filter((c) => !placed.has(c.id)).map((c) => [c.id])];
}

/**
 * Which card to throw away from 14: the one whose loss leaves the best hand.
 * Ties: keep jokers, throw the card worth more points.
 */
function bestDiscard(t, hand14) {
  let best = null;
  for (const card of hand14) {
    const rest = hand14.filter((c) => c !== card);
    const value = judge(t, rest);
    const wild = isWild(card, t.openJokerRank) ? 1 : 0;
    const pts = points(t, card);
    if (!best || value < best.value || (value === best.value && (wild < best.wild || (wild === best.wild && pts > best.pts)))) {
      best = { card, rest, value, wild, pts };
    }
  }
  return best;
}

/**
 * Start of mawa's turn (13 cards).
 * @returns {{type: 'declare', groups: string[][]} | {type: 'drop'} | {type: 'draw', source: 'draw'|'discard'}}
 */
function decideTurnStart(t) {
  const groups = winningGroups(t, t.hand);
  if (groups) return { type: 'declare', groups };

  const now = judge(t, t.hand);
  // A hopeless first hand: a person drops it now and then, unless the drop itself would put them out.
  if (t.turnsTaken === 0 && now >= 70 && t.myScore + t.config.firstDropPenalty < t.config.eliminationThreshold
    && t.random() < 0.6) {
    return { type: 'drop' };
  }
  // Take the open card only when it clearly helps (and not the very card it would throw back).
  if (t.top && t.topPickable) {
    const withTop = bestDiscard(t, [...t.hand, t.top]);
    const gain = now - withTop.value;
    if (withTop.card.id !== t.top.id && (gain >= 8 || (gain >= 3 && t.random() < 0.7))) return { type: 'draw', source: 'discard' };
  }
  return { type: 'draw', source: 'draw' };
}

/**
 * After drawing (14 cards): what to throw away, whether the rest wins, and
 * (SET) whether the rest is one card away so it can press 1 CARD TO WIN.
 * @returns {{cardId: string, declareGroups: string[][]|null, oneCardToWin: boolean}}
 */
function decideDiscard(t) {
  const best = bestDiscard(t, t.hand);
  const declareGroups = winningGroups(t, best.rest);
  let oneCardToWin = false;
  if (!declareGroups && t.game === 'SET' && t.oneCardToWinFeature) {
    oneCardToWin = rulesOf(t.game).checkOneCardToWin(best.rest, ctxOf(t), t.deckCount).eligible;
  }
  return { cardId: best.card.id, declareGroups, oneCardToWin };
}

/** Discarded but the turn is still open (13 cards): declare if it wins, else end the turn. */
function decideEndOfTurn(t) {
  const groups = winningGroups(t, t.hand);
  return groups ? { type: 'declare', groups } : { type: 'end-turn' };
}

module.exports = { decideTurnStart, decideDiscard, decideEndOfTurn, arrange, judge, winningGroups, bestDiscard };
