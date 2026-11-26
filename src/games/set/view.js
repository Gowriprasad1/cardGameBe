'use strict';

const { STAGE, PHASE } = require('./constants');
const { toClientCard, scoreboardOf } = require('./game-engine');

/**
 * The ONLY projection of game state that may leave the server.
 *
 * For `playerId` it contains:
 *  - their own cards and arrangement
 *  - for everyone else: hand COUNT only
 *  - draw pile: COUNT only (never its contents or order)
 *  - discard pile: top card and count
 *  - the open joker card, which is face-up by the rules
 *  - results of finished rounds (hands are revealed only at round end)
 *
 * It never includes opponents' cards, the draw pile, or the engine's
 * internal state.
 *
 * @param {object} state engine state
 * @param {string} playerId
 */
/**
 * Build the `viewFor` projection for a ruleset (see game-engine.js createEngine).
 * @param {{features: object, checkOneCardToWin: Function}} rules
 */
function createViewFor(rules) {
  return function viewFor(state, playerId) {
    const { round } = state;
    const ctx = { config: state.config, openJokerRank: round ? round.openJokerRank : null };
    const inRound = state.stage === STAGE.IN_ROUND;

    const view = {
      game: state.game,
      features: rules.features,
      version: state.version,
      stage: state.stage,
      roundNo: state.roundNo,
      deckCount: state.deckCount,
      winnerId: state.winnerId,
      config: {
        eliminationThreshold: state.config.eliminationThreshold,
        firstDropPenalty: state.config.firstDropPenalty,
        middleDropPenalty: state.config.middleDropPenalty,
        invalidDeclarationPenalty: state.config.invalidDeclarationPenalty,
        turnTimerSeconds: state.config.turnTimerSeconds,
      },
      scoreboard: scoreboardOf(state),
      history: state.history.map((r) => ({
        roundNo: r.roundNo, winnerId: r.winnerId, endReason: r.endReason, dealerId: r.dealerId, results: r.results,
      })),
      players: state.seatOrder.map((id, seat) => {
        const p = state.players[id];
        return {
          playerId: id,
          nickname: p.nickname,
          seat,
          status: p.status,
          cumulativeScore: p.score,
          drops: p.drops,
          roundStatus: round ? round.playerStatus[id] || null : null,
          handCount: round && round.hands[id] ? round.hands[id].length : 0,
          isDealer: round ? round.dealerId === id : false,
          isCurrent: inRound && round.currentPlayerId === id,
          oneCardToWin: round ? Boolean(round.oneCardToWin[id]) : false,
        };
      }),
      round: null,
      me: null,
    };

    if (round) {
      const top = round.discardPile[round.discardPile.length - 1];
      view.round = {
        no: round.no,
        dealerId: round.dealerId,
        currentPlayerId: inRound ? round.currentPlayerId : null,
        phase: inRound ? round.phase : null,
        turnNo: round.turnNo,
        openJokerRank: round.openJokerRank,
        openJokerCard: toClientCard(round.openJokerCard, ctx),
        drawPileCount: round.drawPile.length,
        discardTop: top ? toClientCard(top, ctx) : null,
        discardCount: round.discardPile.length,
        // a printed joker on top of the open pile cannot be taken
        discardPickable: Boolean(top) && !top.joker,
        // after a valid declaration: the shown (winning) hand is public, and who still has to submit
        show: inRound && round.phase === PHASE.SHOWING && round.show ? {
          declarerId: round.show.declarerId,
          waitingFor: round.show.pending.slice(),
          submitted: round.show.submitted.slice(),
          cards: round.hands[round.show.declarerId].map((c) => toClientCard(c, ctx)),
          groups: round.show.groups.map((g) => ({ cardIds: g.cardIds, isLife: Boolean(g.isLife), kind: g.kind || null })),
        } : null,
      };
      const mine = round.hands[playerId];
      if (mine) {
        const myTurn = inRound && round.currentPlayerId === playerId;
        view.me = {
          playerId,
          hand: mine.map((c) => toClientCard(c, ctx)),
          groups: round.groups[playerId],
          oneCardToWin: Boolean(round.oneCardToWin[playerId]),
          // Computed by the server so the client never has to judge a hand itself.
          oneCardEligible: inRound && round.playerStatus[playerId] === 'playing' && rules.checkOneCardToWin(mine, ctx, state.deckCount).eligible,
          isMyTurn: myTurn,
          canDrop: myTurn && round.phase === PHASE.AWAITING_DRAW,
          canDeclare: myTurn && round.phase !== PHASE.AWAITING_DISCARD,
          // somebody showed a valid hand: arrange your cards and submit before the time runs out
          canSubmitShow: inRound && round.phase === PHASE.SHOWING && Boolean(round.show) && round.show.pending.includes(playerId),
          turnsTaken: round.turnsTaken[playerId],
        };
      }
    }
    return view;
  }
  }

const viewFor = createViewFor(require('./set-rules'));

module.exports = { viewFor, createViewFor };
