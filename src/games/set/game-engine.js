'use strict';

/**
 * SET game engine: a pure state machine.
 *
 *   createGame({players, config, rng})            -> { state, events }
 *   applyAction(state, action, { rng })           -> { state, events }
 *
 * No Express, no Socket.IO, no database. applyAction never mutates the state
 * it is given; it clones, applies, validates card integrity and returns the
 * new state. A rejected action throws GameError and leaves the old state alone.
 *
 * Events are { name, to, payload } where `to` is 'all' or one player id.
 * Cards only ever appear in events addressed to their owner, or in public
 * events for cards that are face-up by the rules (discards, open joker,
 * round-end reveals).
 */

const {
  PHASE, STAGE, PLAYER_STATUS, ROUND_STATUS, END_REASON, PENALTY_REASON,
} = require('./constants');
const { gameError } = require('./errors');
const { deckCountForPlayers, buildDecks, verifyCardSet } = require('./deck.service');
const { shuffle, secureRandomInt } = require('./shuffle.service');
const { pickInitialDealer, nextDealer, firstToPlay } = require('./dealer.service');
const { dealRound } = require('./card-distribution.service');
const { jokerType } = require('./joker.service');
const {
  eligibleIds, findNewlyEliminated, markEliminated, resolveGameEnd,
} = require('./elimination.service');
const {
  assertPlayerInRound, assertActivePlayer, assertPhase, nextPlaying, playingIds,
} = require('./turn.service');
const { RANKS } = require('./constants');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emit(events, name, payload, to = 'all') {
  events.push({ name, to, payload });
}

function ctxOf(state) {
  return { config: state.config, openJokerRank: state.round ? state.round.openJokerRank : null };
}

/** Card as a client may see it. */
function toClientCard(card, ctx) {
  return {
    id: card.id,
    rank: card.rank,
    suit: card.suit,
    isPrintedJoker: card.joker,
    isOpenJoker: jokerType(card, ctx) === 'open',
  };
}

/**
 * Can the open pile's top card be taken? Yes, unless it is a printed joker a
 * player threw there. The card turned face up at the deal has no entry in the
 * discard history, so a printed joker dealt face up can be taken.
 */
function topIsPickable(round) {
  const top = round.discardPile[round.discardPile.length - 1];
  if (!top) return false;
  if (!top.joker) return true;
  if (!round.discardLog) return false; // a round saved before the history existed: the old rule
  return !round.discardLog.some((e) => e.card.id === top.id && !e.takenBy);
}

// ---------------------------------------------------------------------------
// closed joker: the open joker is shown only to players who have a LIFE
// ---------------------------------------------------------------------------

/**
 * Does this hand hold a LIFE as the player sees it: 4 cards of one number,
 * printed jokers aside? (A player who cannot see the joker cannot tell that
 * their four cards are of the joker number, so those unlock it too and the
 * player then learns it.)
 */
function looksLikeLife(hand, config) {
  const counts = new Map();
  for (const c of hand) if (!c.joker) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  return [...counts.values()].some((n) => n >= config.lifeMinNatural);
}

/**
 * May this player see the open joker now? Always in 'open' mode. In 'closed'
 * mode: once they have had a LIFE this round (it stays seen), and for
 * everyone once somebody has declared or the round is over.
 */
function canSeeJoker(state, playerId) {
  if (state.config.jokerMode !== 'closed') return true;
  const { round } = state;
  if (!round || state.stage !== STAGE.IN_ROUND || round.result || round.phase === PHASE.SHOWING) return true;
  return Boolean(round.jokerSeen && round.jokerSeen[playerId]);
}

/** Closed joker: mark players who now hold a LIFE, and tell each one the joker once. */
function refreshJokerSeen(state, events) {
  const { round, config } = state;
  if (config.jokerMode !== 'closed' || !round || round.result) return;
  if (!round.jokerSeen) round.jokerSeen = {};
  const ctx = ctxOf(state);
  for (const id of round.order) {
    if (round.jokerSeen[id] || round.playerStatus[id] !== ROUND_STATUS.PLAYING) continue;
    if (!looksLikeLife(round.hands[id], config)) continue;
    round.jokerSeen[id] = true;
    emit(events, 'joker-revealed', {
      roundNo: round.no, openJokerRank: round.openJokerRank, openJokerCard: toClientCard(round.openJokerCard, ctx),
    }, id);
  }
}

/** A copy of an event payload with every trace of the open joker removed. */
function hideJoker(value) {
  if (Array.isArray(value)) return value.map(hideJoker);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'openJokerRank' || k === 'openJokerCard') out[k] = null;
    else if (k === 'isOpenJoker') out[k] = false;
    else out[k] = hideJoker(v);
  }
  return out;
}

function rankIndex(card) {
  return card.joker ? 99 : RANKS.indexOf(card.rank);
}

function initialGroups(hand) {
  return hand.slice().sort((a, b) => rankIndex(a) - rankIndex(b)).map((c) => [c.id]);
}

function emitHand(state, playerId, events) {
  const { round } = state;
  const ctx = ctxOf(state);
  emit(events, 'hand-updated', {
    roundNo: round.no,
    cards: round.hands[playerId].map((c) => toClientCard(c, ctx)),
    groups: round.groups[playerId],
  }, playerId);
}

function scoreboardOf(state) {
  return state.seatOrder.map((id) => {
    const p = state.players[id];
    const penalty = state.round && state.round.penalties[id] ? state.round.penalties[id].penalty : 0;
    return {
      playerId: id,
      nickname: p.nickname,
      cumulativeScore: p.score,
      roundPenalty: penalty,
      drops: p.drops,
      status: p.status,
      isWinner: state.winnerId === id,
    };
  });
}

function emitScoreboard(state, events) {
  emit(events, 'scoreboard-updated', { roundNo: state.roundNo, scoreboard: scoreboardOf(state) });
}

/** Card integrity: every physical card exists exactly once in the round. */
function verifyRoundIntegrity(state) {
  const { round } = state;
  if (!round) return;
  const all = [round.openJokerCard, ...round.drawPile, ...round.discardPile];
  for (const hand of Object.values(round.hands)) all.push(...hand);
  verifyCardSet(all, state.deckCount);
}

/** Charge a penalty at most once per player per round. Returns true if charged. */
function chargePenalty(round, playerId, reason, penalty, extra = {}) {
  if (round.penalties[playerId]) return false;
  round.penalties[playerId] = { reason, penalty, ...extra };
  return true;
}

/**
 * Build a draw-and-discard game engine for a ruleset.
 *
 * `rules` supplies everything game specific:
 *   code, resolveConfig(overrides), validateDeclaration({hand, groups, ctx}),
 *   scoreHand(hand, ctx), dropPenalty(turnsTaken, config),
 *   invalidDeclarationPenalty(config), checkOneCardToWin(hand, ctx, deckCount)
 * The turn flow, rounds, dealing, drops, timeouts, penalties, elimination and
 * card-integrity checks are shared by every game.
 */
function createEngine(rules) {
  // ---------------------------------------------------------------------------
  // creating a game and starting rounds
  // ---------------------------------------------------------------------------

  /**
   * @param {{players: {id: string, nickname?: string}[], config?: object, rng?: Function}} args
   *   players in seat order
   */
  function createGame({ players, config = {}, rng = secureRandomInt }) {
    const cfg = rules.resolveConfig(config);
    if (!Array.isArray(players) || players.length < cfg.minPlayers || players.length > cfg.maxPlayers) {
      throw gameError('INVALID_PLAYER_COUNT');
    }
    const ids = players.map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw gameError('DUPLICATE_PLAYER');

    const state = {
      version: 0,
      game: rules.code,
      stage: STAGE.BETWEEN_ROUNDS,
      config: cfg,
      deckCount: deckCountForPlayers(ids.length),
      seatOrder: ids,
      players: {},
      roundNo: 0,
      round: null,
      history: [],
      winnerId: null,
    };
    for (const p of players) {
      state.players[p.id] = {
        id: p.id,
        nickname: p.nickname || p.id,
        score: 0,
        status: PLAYER_STATUS.ACTIVE,
        drops: 0,
        eliminatedInRound: null,
      };
    }

    const events = [];
    emit(events, 'game-started', {
      players: ids.map((id, seat) => ({ playerId: id, nickname: state.players[id].nickname, seat })),
      deckCount: state.deckCount,
      config: publicConfig(cfg),
    });
    startRound(state, pickInitialDealer(ids, rng), rng, events);
    verifyRoundIntegrity(state);
    return { state, events };
  }

  function publicConfig(cfg) {
    return {
      cardsPerPlayer: cfg.cardsPerPlayer,
      eliminationThreshold: cfg.eliminationThreshold,
      firstDropPenalty: cfg.firstDropPenalty,
      middleDropPenalty: cfg.middleDropPenalty,
      invalidDeclarationPenalty: cfg.invalidDeclarationPenalty,
      turnTimerSeconds: cfg.turnTimerSeconds,
    };
  }

  function startRound(state, dealerId, rng, events) {
    const eligible = eligibleIds(state.players, state.seatOrder);
    state.roundNo += 1;
    const deal = dealRound({ playerIds: eligible, deckCount: state.deckCount, config: state.config, rng });
    const firstId = firstToPlay(state.seatOrder, dealerId, eligible);

    const round = {
      no: state.roundNo,
      dealerId,
      openJokerRank: deal.openJokerRank,
      openJokerCard: deal.openJokerCard,
      drawPile: deal.drawPile,
      discardPile: deal.discardPile,
      // every card a player threw on the open pile this round, in order (public: everyone saw it land)
      discardLog: [],
      hands: deal.hands,
      groups: {},
      order: eligible,
      playerStatus: {},
      turnsTaken: {},
      timeouts: {},
      oneCardToWin: {},
      penalties: {},
      jokerSeen: {}, // closed joker: who has had a LIFE this round and so sees the open joker
      currentPlayerId: firstId,
      phase: PHASE.AWAITING_DRAW,
      turnNo: 1,
      lastDrawnId: null,
      result: null,
    };
    for (const id of eligible) {
      round.groups[id] = initialGroups(round.hands[id]);
      round.playerStatus[id] = ROUND_STATUS.PLAYING;
      round.turnsTaken[id] = 0;
      round.timeouts[id] = 0;
      round.oneCardToWin[id] = false;
    }
    state.round = round;
    state.stage = STAGE.IN_ROUND;

    const ctx = ctxOf(state);
    emit(events, 'dealer-selected', { roundNo: round.no, dealerId });
    emit(events, 'cards-distributed', {
      roundNo: round.no,
      openJokerRank: round.openJokerRank,
      openJokerCard: toClientCard(round.openJokerCard, ctx),
      discardTop: toClientCard(round.discardPile[round.discardPile.length - 1], ctx),
      drawPileCount: round.drawPile.length,
      handCounts: Object.fromEntries(eligible.map((id) => [id, round.hands[id].length])),
    });
    for (const id of eligible) emitHand(state, id, events);
    refreshJokerSeen(state, events);
    emit(events, 'player-turn', {
      roundNo: round.no, turnNo: round.turnNo, playerId: firstId, seconds: state.config.turnTimerSeconds,
    });
  }

  // ---------------------------------------------------------------------------
  // turn actions
  // ---------------------------------------------------------------------------

  function reshuffleIfNeeded(round, config, rng) {
    if (round.drawPile.length > 0) return;
    if (!config.reshuffleOnEmpty || round.discardPile.length <= 1) throw gameError('PILE_EMPTY');
    const top = round.discardPile.pop();
    round.drawPile = shuffle(round.discardPile, rng);
    round.discardPile = [top];
    // the thrown cards went back into the closed pile: only the card still on top stays in the history
    if (round.discardLog) round.discardLog = round.discardLog.filter((e) => e.card.id === top.id && !e.takenBy).slice(-1);
  }

  function doDraw(state, playerId, source, events, rng, { manual }) {
    const { round } = state;
    if (source !== 'draw' && source !== 'discard') throw gameError('INVALID_SOURCE');
    let card;
    if (source === 'draw') {
      reshuffleIfNeeded(round, state.config, rng);
      card = round.drawPile.pop();
    } else {
      if (round.discardPile.length === 0) throw gameError('PILE_EMPTY');
      // A printed joker a player threw on the open pile cannot be picked up. The card turned
      // face up at the deal can, even a printed joker. Cards of the open-joker number always can.
      if (!topIsPickable(round)) throw gameError('JOKER_NOT_PICKABLE');
      card = round.discardPile.pop();
      const logged = (round.discardLog || []).findLast((e) => e.card.id === card.id && !e.takenBy);
      if (logged) logged.takenBy = playerId;
    }
    round.hands[playerId].push(card);
    round.groups[playerId].push([card.id]);
    round.phase = PHASE.AWAITING_DISCARD;
    round.lastDrawnId = card.id;
    if (manual) round.timeouts[playerId] = 0;

    const ctx = ctxOf(state);
    const top = round.discardPile[round.discardPile.length - 1];
    emit(events, 'card-drawn', {
      playerId,
      source,
      // Only the discard pile's top card is face-up, so only then is the card public.
      card: source === 'discard' ? toClientCard(card, ctx) : null,
      drawPileCount: round.drawPile.length,
      discardTop: top ? toClientCard(top, ctx) : null,
    });
    emitHand(state, playerId, events);
  }

  function removeFromGroups(round, playerId, cardId) {
    round.groups[playerId] = round.groups[playerId]
      .map((g) => g.filter((id) => id !== cardId))
      .filter((g) => g.length > 0);
  }

  function doDiscard(state, playerId, cardId, events) {
    const { round } = state;
    const hand = round.hands[playerId];
    const index = hand.findIndex((c) => c.id === cardId);
    if (index === -1) throw gameError('CARD_NOT_IN_HAND');
    const [card] = hand.splice(index, 1);
    round.discardPile.push(card);
    if (!round.discardLog) round.discardLog = []; // a round saved before the history existed
    round.discardLog.push({ by: playerId, card, takenBy: null });
    removeFromGroups(round, playerId, cardId);
    round.phase = PHASE.AWAITING_END_TURN;

    emit(events, 'card-discarded', {
      playerId,
      card: toClientCard(card, ctxOf(state)),
      drawPileCount: round.drawPile.length,
    });
    emitHand(state, playerId, events);

    // The "1 CARD TO WIN" flag must always reflect the real hand.
    if (round.oneCardToWin[playerId] && !rules.checkOneCardToWin(hand, ctxOf(state), state.deckCount).eligible) {
      round.oneCardToWin[playerId] = false;
      emit(events, 'one-card-to-win', { playerId, active: false });
    }
  }

  function advanceTurn(state, fromId, events) {
    const { round } = state;
    const nextId = nextPlaying(round, fromId);
    round.currentPlayerId = nextId;
    round.phase = PHASE.AWAITING_DRAW;
    round.turnNo += 1;
    round.lastDrawnId = null;
    emit(events, 'player-turn', {
      roundNo: round.no, turnNo: round.turnNo, playerId: nextId, seconds: state.config.turnTimerSeconds,
    });
  }

  function completeTurn(state, playerId, events) {
    state.round.turnsTaken[playerId] += 1;
    advanceTurn(state, playerId, events);
  }

  /** Take a player out of the round, then finish the round or pass the turn. */
  function afterPlayerLeaves(state, leaverId, events) {
    const remaining = playingIds(state.round);
    if (remaining.length === 1) {
      finishRound(state, {
        winnerId: remaining[0], endReason: END_REASON.LAST_PLAYER_STANDING, scoreRemaining: false,
      }, events);
      return;
    }
    advanceTurn(state, leaverId, events);
  }

  function doDrop(state, playerId, events, { auto = false } = {}) {
    const { round, config } = state;
    const { type, penalty, reason } = rules.dropPenalty(round.turnsTaken[playerId], config);
    // A player can only ever hold one penalty per round (never both drop penalties).
    chargePenalty(round, playerId, reason, penalty);
    round.playerStatus[playerId] = type === 'first' ? ROUND_STATUS.DROPPED_FIRST : ROUND_STATUS.DROPPED_MIDDLE;
    round.oneCardToWin[playerId] = false;
    state.players[playerId].drops += 1;
    emit(events, 'player-drop', { playerId, type, penalty: round.penalties[playerId].penalty, auto });
    afterPlayerLeaves(state, playerId, events);
  }

  function doDeclare(state, playerId, groups, events) {
    const { round, config } = state;
    if (round.phase === PHASE.AWAITING_DISCARD) throw gameError('DECLARATION_NOT_ALLOWED');
    const hand = round.hands[playerId];
    const ctx = ctxOf(state);
    const check = rules.validateDeclaration({ hand, groups, ctx });

    if (check.valid) {
      emit(events, 'declaration-result', { playerId, valid: true, penalty: 0 });
      const declaredGroups = check.groups.map((g) => ({ cardIds: g.cardIds, rank: g.rank, isLife: Boolean(g.isLife), kind: g.kind || null }));
      startShow(state, playerId, declaredGroups, events);
      return;
    }

    const policy = config.invalidDeclarationPolicy;
    const charged = chargePenalty(round, playerId, PENALTY_REASON.INVALID_DECLARATION, rules.invalidDeclarationPenalty(config));
    emit(events, 'declaration-result', {
      playerId, valid: false, penalty: charged ? round.penalties[playerId].penalty : 0, policy,
    });
    // Only the declarer learns what was wrong. Others never see the attempted groups.
    emit(events, 'declaration-errors', { errors: check.errors }, playerId);

    if (policy === 'end-round') {
      finishRound(state, {
        winnerId: null, endReason: END_REASON.INVALID_DECLARATION_END, scoreRemaining: false,
      }, events);
    } else if (policy === 'remove-declarer' || !charged) {
      // continue-declarer allows one penalised attempt; a second failed attempt
      // removes the player without a second penalty.
      round.playerStatus[playerId] = ROUND_STATUS.REMOVED_INVALID;
      round.oneCardToWin[playerId] = false;
      afterPlayerLeaves(state, playerId, events);
    }
  }

  // ---------------------------------------------------------------------------
  // after a valid declaration: the others arrange their cards and submit
  // ---------------------------------------------------------------------------

  /**
   * A valid declaration wins the round. Before it is scored, every other player
   * still in the round gets config.showWindowSeconds to arrange their cards and
   * submit (the "show"). Their points are still the best their hand allows:
   * arranging can never cost them anything. With no window, or nobody else
   * left in the round, the round is scored at once.
   */
  function startShow(state, declarerId, declaredGroups, events) {
    const { round } = state;
    const others = playingIds(round).filter((id) => id !== declarerId);
    const seconds = state.config.showWindowSeconds || 0;
    if (seconds === 0 || others.length === 0) {
      finishRound(state, {
        winnerId: declarerId, endReason: END_REASON.VALID_DECLARATION, scoreRemaining: true, declaredGroups,
      }, events);
      return;
    }
    round.phase = PHASE.SHOWING;
    round.currentPlayerId = null;
    round.turnNo += 1; // a turn timer armed before the declaration is now stale
    round.lastDrawnId = null;
    round.show = { declarerId, groups: declaredGroups, pending: others, submitted: [] };
    const ctx = ctxOf(state);
    emit(events, 'show-started', {
      roundNo: round.no,
      declarerId,
      seconds,
      waitingFor: others,
      // the winning hand is public: everyone sees it while they arrange their own cards
      reveal: {
        cards: round.hands[declarerId].map((c) => toClientCard(c, ctx)),
        groups: declaredGroups.map((g) => ({ cardIds: g.cardIds, isLife: Boolean(g.isLife), kind: g.kind || null })),
      },
    });
  }

  function assertShowing(round) {
    if (round.phase !== PHASE.SHOWING) throw gameError('NOT_SHOWING');
  }

  /** A player finished arranging after somebody's valid declaration. */
  function doSubmitShow(state, playerId, groups, events) {
    const { round } = state;
    assertShowing(round);
    assertPlayerInRound(state, playerId);
    if (!round.show.pending.includes(playerId)) {
      throw gameError(round.show.submitted.includes(playerId) ? 'ALREADY_SUBMITTED' : 'NOT_IN_ROUND');
    }
    if (groups !== undefined) doArrange(state, playerId, groups);
    round.show.pending = round.show.pending.filter((id) => id !== playerId);
    round.show.submitted.push(playerId);
    emit(events, 'show-submitted', { playerId });
    emitHand(state, playerId, events);
    if (round.show.pending.length === 0) finishShow(state, events);
  }

  /** Everyone submitted, or time is up: score the round. */
  function finishShow(state, events) {
    const { show } = state.round;
    finishRound(state, {
      winnerId: show.declarerId, endReason: END_REASON.VALID_DECLARATION, scoreRemaining: true, declaredGroups: show.groups,
    }, events);
  }

  // ---------------------------------------------------------------------------
  // leaving the game for good (the Exit button)
  // ---------------------------------------------------------------------------

  /**
   * The player leaves the game for good, with no penalty: whatever they were
   * holding this round is not counted and their total stays as it was. The
   * round carries on without them (or ends if one player is left in it), and
   * the game ends if only one player remains in it.
   */
  function doLeave(state, playerId, events) {
    const player = state.players[playerId];
    if (!player) throw gameError('NOT_IN_ROOM');
    if (player.status === PLAYER_STATUS.LEFT) throw gameError('PLAYER_LEFT');
    if (player.status === PLAYER_STATUS.ELIMINATED) throw gameError('PLAYER_ELIMINATED');

    const { round } = state;
    const inRound = state.stage === STAGE.IN_ROUND && round.order.includes(playerId)
      && round.playerStatus[playerId] === ROUND_STATUS.PLAYING;

    // The declarer already won this round: score it first, then let them go.
    if (inRound && round.phase === PHASE.SHOWING && round.show.declarerId === playerId) finishShow(state, events);

    player.status = PLAYER_STATUS.LEFT;
    emit(events, 'player-left-game', { playerId, nickname: player.nickname });

    if (state.stage === STAGE.IN_ROUND && inRound) {
      round.playerStatus[playerId] = ROUND_STATUS.LEFT;
      round.oneCardToWin[playerId] = false;
      chargePenalty(round, playerId, PENALTY_REASON.LEFT, 0);
      if (round.phase === PHASE.SHOWING) {
        round.show.pending = round.show.pending.filter((id) => id !== playerId);
        if (round.show.pending.length === 0) finishShow(state, events);
        return;
      }
      const remaining = playingIds(round);
      if (remaining.length <= 1) {
        finishRound(state, {
          winnerId: remaining[0] || null, endReason: END_REASON.LAST_PLAYER_STANDING, scoreRemaining: false,
        }, events);
        return;
      }
      if (round.currentPlayerId === playerId) advanceTurn(state, playerId, events);
      return;
    }
    if (state.stage === STAGE.BETWEEN_ROUNDS) {
      // nobody left to play against: the game is over
      const end = resolveGameEnd({ players: state.players, seatOrder: state.seatOrder, newlyEliminated: [] });
      if (end.finished) completeGame(state, end.winnerId, events);
    }
  }

  function doArrange(state, playerId, groups) {
    assertPlayerInRound(state, playerId);
    const { round } = state;
    const hand = round.hands[playerId];
    if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g))) throw gameError('INVALID_ARRANGEMENT');
    const flat = groups.flat();
    const handIds = new Set(hand.map((c) => c.id));
    if (flat.length !== hand.length || new Set(flat).size !== flat.length || flat.some((id) => !handIds.has(id))) {
      throw gameError('INVALID_ARRANGEMENT');
    }
    round.groups[playerId] = groups.filter((g) => g.length > 0).map((g) => g.slice());
  }

  function doOneCardToWin(state, playerId, active, events) {
    assertPlayerInRound(state, playerId);
    const { round } = state;
    if (round.phase === PHASE.SHOWING) throw gameError('SHOW_IN_PROGRESS');
    if (active) {
      const check = rules.checkOneCardToWin(round.hands[playerId], ctxOf(state), state.deckCount);
      if (!check.eligible) throw gameError('ONE_CARD_NOT_ELIGIBLE');
    }
    round.oneCardToWin[playerId] = Boolean(active);
    emit(events, 'one-card-to-win', { playerId, active: Boolean(active) });
  }

  /** Called by the turn timer when the active player ran out of time. */
  function doTimeout(state, playerId, events, rng) {
    const { round, config } = state;
    assertActivePlayer(state, playerId);

    if (round.phase === PHASE.AWAITING_END_TURN) {
      completeTurn(state, playerId, events);
      return;
    }
    round.timeouts[playerId] += 1;
    if (round.timeouts[playerId] >= config.autoDropAfterTimeouts) {
      doDrop(state, playerId, events, { auto: true });
      return;
    }
    if (round.phase === PHASE.AWAITING_DRAW) doDraw(state, playerId, 'draw', events, rng, { manual: false });
    doDiscard(state, playerId, round.lastDrawnId, events);
    completeTurn(state, playerId, events);
  }

  // ---------------------------------------------------------------------------
  // finishing a round
  // ---------------------------------------------------------------------------

  /**
   * Score the round once, update cumulative scores, eliminate players, and
   * either complete the game or wait for the next round. This function is the
   * only place cumulative scores change; `round.status === completed` makes a
   * second call impossible.
   */
  function finishRound(state, { winnerId, endReason, scoreRemaining, declaredGroups }, events) {
    const { round, config } = state;
    if (round.result) throw gameError('ROUND_NOT_ACTIVE');
    const ctx = ctxOf(state);
    const reveals = {};

    if (winnerId) {
      round.playerStatus[winnerId] = ROUND_STATUS.WINNER;
      chargePenalty(round, winnerId, PENALTY_REASON.WINNER, 0);
      if (declaredGroups) {
        reveals[winnerId] = {
          cards: round.hands[winnerId].map((c) => toClientCard(c, ctx)),
          groups: declaredGroups.map((g) => ({ cardIds: g.cardIds, isLife: Boolean(g.isLife), kind: g.kind || null })),
        };
      }
    }

    for (const id of round.order) {
      if (round.penalties[id]) continue;
      if (scoreRemaining && round.playerStatus[id] === ROUND_STATUS.PLAYING) {
        const scored = rules.scoreHand(round.hands[id], ctx);
        // Every card was already in sets but the player did not declare in time: they still
        // count a little (2), so the one who declared first is the only one on 0.
        const complete = scored.points === 0 && (config.completeHandPenalty || 0) > 0;
        round.penalties[id] = {
          reason: scored.reason,
          penalty: complete ? config.completeHandPenalty : scored.points,
          unmatchedIds: scored.unmatchedIds,
          ...(complete ? { completeHand: true } : {}),
        };
        reveals[id] = {
          cards: round.hands[id].map((c) => toClientCard(c, ctx)),
          groups: scored.groups.map((g) => ({ cardIds: g.cardIds, isLife: Boolean(g.isLife), kind: g.kind || null })),
          unmatchedIds: scored.unmatchedIds,
        };
      } else {
        round.penalties[id] = { reason: PENALTY_REASON.NO_PENALTY, penalty: 0 };
      }
    }

    // Apply scores exactly once.
    for (const id of round.order) state.players[id].score += round.penalties[id].penalty;
    const newlyEliminated = findNewlyEliminated(state.players, state.seatOrder, config.eliminationThreshold);
    markEliminated(state.players, newlyEliminated, round.no);

    const results = round.order.map((id) => ({
      playerId: id,
      penalty: round.penalties[id].penalty,
      reason: round.penalties[id].reason,
      completeHand: Boolean(round.penalties[id].completeHand),
      roundStatus: round.playerStatus[id],
      cumulativeScore: state.players[id].score,
      eliminated: newlyEliminated.includes(id),
    }));
    round.result = { roundNo: round.no, winnerId, endReason, dealerId: round.dealerId, results };
    state.history.push(round.result);

    emit(events, 'round-completed', { ...round.result, reveals });
    for (const id of newlyEliminated) {
      emit(events, 'player-eliminated', {
        playerId: id, cumulativeScore: state.players[id].score, roundNo: round.no,
      });
    }

    const end = resolveGameEnd({ players: state.players, seatOrder: state.seatOrder, newlyEliminated });
    if (end.finished) {
      completeGame(state, end.winnerId, events);
    } else {
      state.stage = STAGE.BETWEEN_ROUNDS;
      emitScoreboard(state, events);
    }
  }

  function completeGame(state, winnerId, events) {
    state.stage = STAGE.COMPLETED;
    state.winnerId = winnerId;
    emitScoreboard(state, events);
    emit(events, 'game-completed', {
      winnerId,
      winnerNickname: state.players[winnerId].nickname,
      totalRounds: state.roundNo,
      finalScoreboard: scoreboardOf(state),
      eliminatedHistory: state.seatOrder
        .filter((id) => state.players[id].status === PLAYER_STATUS.ELIMINATED)
        .map((id) => ({
          playerId: id,
          nickname: state.players[id].nickname,
          cumulativeScore: state.players[id].score,
          eliminatedInRound: state.players[id].eliminatedInRound,
        })),
    });
  }

  // ---------------------------------------------------------------------------
  // public entry point
  // ---------------------------------------------------------------------------

  /**
   * @param {object} state
   * @param {{type: string, playerId?: string, [k: string]: any}} action
   * @param {{rng?: Function}} [options]
   * @returns {{state: object, events: {name: string, to: string, payload: object}[]}}
   */
  function applyAction(state, action, options = {}) {
    const rng = options.rng || secureRandomInt;
    if (!action || typeof action.type !== 'string') throw gameError('UNKNOWN_ACTION');
    if (state.stage === STAGE.COMPLETED) throw gameError('GAME_FINISHED');

    const next = structuredClone(state);
    const events = [];
    const { playerId } = action;

    if (action.type === 'start-next-round') {
      if (next.stage !== STAGE.BETWEEN_ROUNDS) throw gameError('NOT_BETWEEN_ROUNDS');
      const active = eligibleIds(next.players, next.seatOrder);
      startRound(next, nextDealer(next.seatOrder, next.round.dealerId, active), rng, events);
    } else if (action.type === 'leave') {
      // allowed during a round and between rounds
      doLeave(next, playerId, events);
    } else {
      if (next.stage !== STAGE.IN_ROUND) throw gameError('ROUND_NOT_ACTIVE');
      const { round } = next;
      switch (action.type) {
        case 'draw':
          assertActivePlayer(next, playerId);
          assertPhase(round, [PHASE.AWAITING_DRAW], 'draw');
          doDraw(next, playerId, action.source, events, rng, { manual: true });
          break;
        case 'discard': {
          assertActivePlayer(next, playerId);
          assertPhase(round, [PHASE.AWAITING_DISCARD], 'discard');
          doDiscard(next, playerId, action.cardId, events);
          if (action.endTurn !== false) completeTurn(next, playerId, events);
          break;
        }
        case 'end-turn':
          assertActivePlayer(next, playerId);
          assertPhase(round, [PHASE.AWAITING_END_TURN], 'end-turn');
          completeTurn(next, playerId, events);
          break;
        case 'drop':
          assertActivePlayer(next, playerId);
          assertPhase(round, [PHASE.AWAITING_DRAW], 'drop');
          doDrop(next, playerId, events);
          break;
        case 'declare':
          assertActivePlayer(next, playerId);
          assertPhase(round, [PHASE.AWAITING_DRAW, PHASE.AWAITING_END_TURN], 'declare');
          doDeclare(next, playerId, action.groups, events);
          break;
        case 'arrange':
          doArrange(next, playerId, action.groups);
          emitHand(next, playerId, events);
          break;
        case 'one-card-to-win':
          doOneCardToWin(next, playerId, action.active !== false, events);
          break;
        case 'timeout':
          doTimeout(next, playerId, events, rng);
          break;
        case 'submit-show':
          doSubmitShow(next, playerId, action.groups, events);
          break;
        case 'show-timeout':
          // the show window ran out: score the round with everyone's cards as they are
          assertShowing(round);
          finishShow(next, events);
          break;
        default:
          throw gameError('UNKNOWN_ACTION');
      }
    }

    refreshJokerSeen(next, events);
    next.version += 1;
    verifyRoundIntegrity(next);
    return { state: next, events };
  }

  /**
   * What the platform should schedule next: the active player's turn deadline,
   * or the end of the show window after a valid declaration.
   * @returns {{kind: 'turn'|'show', playerId: string|null, seconds: number, roundNo: number, turnNo: number}|null}
   */
  function nextTimer(state) {
    if (state.stage !== STAGE.IN_ROUND) return null;
    const { round, config } = state;
    if (round.phase === PHASE.SHOWING) {
      return { kind: 'show', playerId: null, seconds: config.showWindowSeconds || 0, roundNo: round.no, turnNo: round.turnNo };
    }
    if (config.turnTimerSeconds === 0) return null;
    return {
      kind: 'turn',
      playerId: round.currentPlayerId,
      seconds: config.turnTimerSeconds,
      roundNo: round.no,
      turnNo: round.turnNo,
    };
  }

  return { createGame, applyAction, nextTimer };
}

const setEngine = createEngine(require('./set-rules'));

module.exports = {
  createEngine,
  ...setEngine,
  scoreboardOf, toClientCard, verifyRoundIntegrity, buildDecks, topIsPickable, canSeeJoker, hideJoker,
};
