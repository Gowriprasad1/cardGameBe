'use strict';

const { valuesClause } = require('../pool');

/** game_sessions ----------------------------------------------------------- */

async function insertSession(db, { roomId, gameTypeId, config, deckCount, firstDealerId, snapshot, version }) {
  const { rows } = await db.query(
    `INSERT INTO game_sessions (room_id, game_type_id, config, deck_count, first_dealer_id, state_snapshot, state_version)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7) RETURNING id, started_at`,
    [roomId, gameTypeId, JSON.stringify(config), deckCount, firstDealerId, JSON.stringify(snapshot), version],
  );
  return rows[0];
}

/**
 * Save the engine snapshot. The version guard makes an out-of-order or
 * duplicate write a no-op (returns false) instead of rolling state back.
 */
async function saveSnapshot(db, { sessionId, version, roundNo, snapshot }) {
  const { rowCount } = await db.query(
    `UPDATE game_sessions SET state_snapshot = $3::jsonb, state_version = $2, current_round_no = $4
      WHERE id = $1 AND state_version < $2`,
    [sessionId, version, JSON.stringify(snapshot), roundNo],
  );
  return rowCount === 1;
}

async function completeSession(db, { sessionId, winnerRoomPlayerId, status = 'completed' }) {
  await db.query(
    `UPDATE game_sessions SET status = $2, winner_player_id = $3, completed_at = now() WHERE id = $1`,
    [sessionId, status, winnerRoomPlayerId],
  );
}

async function loadLiveSessions(db) {
  return (await db.query(
    `SELECT s.id, s.room_id, s.state_snapshot, s.state_version, s.started_at, r.room_code
       FROM game_sessions s JOIN game_rooms r ON r.id = s.room_id
      WHERE s.status = 'in_progress'`,
  )).rows;
}

/**
 * Remove the bulky working data of a session: every card, every logged action
 * and the saved game state. The result (rounds, scores, history, totals) stays.
 * One statement, one round trip.
 */
async function purgeSessionDetails(db, sessionId) {
  await db.query(
    `WITH c AS (DELETE FROM card_decks WHERE round_id IN (SELECT id FROM game_rounds WHERE session_id = $1) RETURNING 1),
          a AS (DELETE FROM game_actions WHERE session_id = $1 RETURNING 1)
     UPDATE game_sessions SET state_snapshot = NULL WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Delete finished or abandoned rooms (and everything under them) that ended
 * more than `days` days ago. Sessions go first so their rounds, scores and
 * history are removed before the room's players.
 * @returns {Promise<number>} number of rooms deleted
 */
async function purgeOldRooms(db, days) {
  const { rows } = await db.query(
    `SELECT id FROM game_rooms
      WHERE status IN ('finished', 'abandoned')
        AND COALESCE(finished_at, updated_at) < now() - ($1::int * interval '1 day')`,
    [days],
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await db.withTransaction(async (tx) => {
    await tx.query('DELETE FROM game_sessions WHERE room_id = ANY($1::uuid[])', [ids]);
    await tx.query('DELETE FROM game_rooms WHERE id = ANY($1::uuid[])', [ids]);
  });
  return ids.length;
}

/** game_rounds ------------------------------------------------------------- */

async function insertRound(db, { sessionId, roundNo, dealerRoomPlayerId, openJokerRank }) {
  const { rows } = await db.query(
    `INSERT INTO game_rounds (session_id, round_no, dealer_player_id, open_joker_rank)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [sessionId, roundNo, dealerRoomPlayerId, openJokerRank],
  );
  return rows[0].id;
}

async function findRoundId(db, { sessionId, roundNo }) {
  const { rows } = await db.query('SELECT id FROM game_rounds WHERE session_id = $1 AND round_no = $2', [sessionId, roundNo]);
  return rows[0] ? rows[0].id : null;
}

async function completeRound(db, { roundId, winnerRoomPlayerId, endReason, turnNo }) {
  await db.query(
    `UPDATE game_rounds SET status = 'completed', winner_player_id = $2, end_reason = $3, turn_no = $4, ended_at = now()
      WHERE id = $1`,
    [roundId, winnerRoomPlayerId, endReason, turnNo],
  );
}

async function insertRoundPlayers(db, roundId, rows) {
  if (rows.length === 0) return;
  const { sql, params } = valuesClause(rows.map((r) => [roundId, r.roomPlayerId, r.turnOrder]));
  await db.query(`INSERT INTO round_players (round_id, room_player_id, turn_order) VALUES ${sql}`, params);
}

/** One statement for all players of a round. */
async function updateRoundPlayers(db, roundId, rows) {
  if (rows.length === 0) return;
  const { sql, params } = valuesClause(
    rows.map((r) => [roundId, r.roomPlayerId, r.status, r.turnsTaken, r.timeouts, r.oneCardToWin]),
    ['uuid', 'uuid', 'varchar', 'int', 'int', 'boolean'],
  );
  await db.query(
    `UPDATE round_players rp SET status = v.status, turns_taken = v.turns, consecutive_timeouts = v.timeouts, one_card_to_win = v.one
       FROM (VALUES ${sql}) AS v(round_id, room_player_id, status, turns, timeouts, one)
      WHERE rp.round_id = v.round_id AND rp.room_player_id = v.room_player_id`,
    params,
  );
}

/**
 * Cards of a round: every physical card with its pile position, plus each
 * player's hand arrangement. Written when the round is dealt and again when it
 * ends. During the round the authoritative copy is the session snapshot.
 *
 * @param {object} round engine round
 * @param {(userId: string) => string} roomPlayerIdOf
 */
async function replaceRoundCards(db, roundId, round, roomPlayerIdOf) {
  await db.query('DELETE FROM card_decks WHERE round_id = $1', [roundId]); // cascades to player_cards

  const deckRows = [];
  const push = (card, location, position) => deckRows.push([
    roundId, card.id, card.deck, card.suit, card.rank, card.joker, location, position,
  ]);
  round.drawPile.forEach((c, i) => push(c, 'draw', i));
  round.discardPile.forEach((c, i) => push(c, 'discard', i));
  push(round.openJokerCard, 'open_joker', null);
  const handRows = [];
  for (const [userId, hand] of Object.entries(round.hands)) {
    const groups = round.groups[userId] || [];
    hand.forEach((c) => {
      push(c, 'hand', null);
      let groupNo = groups.findIndex((g) => g.includes(c.id));
      if (groupNo < 0) groupNo = null;
      const sortOrder = groupNo === null ? 0 : groups[groupNo].indexOf(c.id);
      handRows.push([roundId, c.id, roomPlayerIdOf(userId), groupNo, sortOrder]);
    });
  }

  const decks = valuesClause(deckRows);
  await db.query(
    `INSERT INTO card_decks (round_id, instance_id, deck_no, suit, rank, is_printed_joker, location, pile_position)
     VALUES ${decks.sql}`,
    decks.params,
  );
  const hands = valuesClause(handRows);
  await db.query(
    `INSERT INTO player_cards (round_id, instance_id, room_player_id, group_no, sort_order) VALUES ${hands.sql}`,
    hands.params,
  );
}

/** player_scores / room_players -------------------------------------------- */

async function insertScores(db, { sessionId, roundId, rows }) {
  if (rows.length === 0) return;
  const { sql, params } = valuesClause(
    rows.map((r) => [sessionId, roundId, r.roomPlayerId, r.reason, r.penalty, JSON.stringify(r.unmatched), r.cumulativeAfter, r.eliminatedNow]),
    [null, null, null, null, null, 'jsonb', null, null],
  );
  // The (round, player) unique key makes a duplicate score impossible.
  await db.query(
    `INSERT INTO player_scores (session_id, round_id, room_player_id, reason, penalty, unmatched_cards, cumulative_after, eliminated_now)
     VALUES ${sql} ON CONFLICT (round_id, room_player_id) DO NOTHING`,
    params,
  );
}

/** One statement for the cumulative scores, drops and eliminations of every seat. */
async function updateRoomPlayerTotals(db, rows) {
  if (rows.length === 0) return;
  const { sql, params } = valuesClause(
    rows.map((r) => [r.roomPlayerId, r.score, r.drops, r.eliminated, r.eliminatedRoundNo]),
    ['uuid', 'int', 'int', 'boolean', 'int'],
  );
  await db.query(
    `UPDATE room_players rp SET cumulative_score = v.score, total_drops = v.drops,
       status = CASE WHEN v.elim THEN 'eliminated' ELSE rp.status END,
       eliminated_at = CASE WHEN v.elim THEN COALESCE(rp.eliminated_at, now()) ELSE rp.eliminated_at END,
       eliminated_round_no = CASE WHEN v.elim THEN COALESCE(rp.eliminated_round_no, v.rno) ELSE rp.eliminated_round_no END
      FROM (VALUES ${sql}) AS v(id, score, drops, elim, rno)
     WHERE rp.id = v.id`,
    params,
  );
}

/** game_actions ------------------------------------------------------------ */

/**
 * Record an accepted action AND save the new snapshot in ONE statement (one
 * database round trip, atomic by itself). `inserted` is 0 when the idempotency
 * key was already used; `updated` is 0 when the snapshot version guard refused.
 * @returns {Promise<{inserted: number, updated: number}>}
 */
async function recordAction(db, { sessionId, roundNo, roomPlayerId, actionType, payload, idempotencyKey, version, snapshot, currentRoundNo }) {
  const { rows } = await db.query(
    `WITH a AS (
       INSERT INTO game_actions (session_id, round_id, room_player_id, action_type, payload, idempotency_key, state_version)
       VALUES ($1, (SELECT id FROM game_rounds WHERE session_id = $1 AND round_no = $2), $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT DO NOTHING RETURNING 1
     ), u AS (
       UPDATE game_sessions SET state_snapshot = $8::jsonb, state_version = $7, current_round_no = $9
        WHERE id = $1 AND state_version < $7 AND EXISTS (SELECT 1 FROM a) RETURNING 1
     )
     SELECT (SELECT count(*) FROM a)::int AS inserted, (SELECT count(*) FROM u)::int AS updated`,
    [sessionId, roundNo, roomPlayerId, actionType, JSON.stringify(payload), idempotencyKey, version, JSON.stringify(snapshot), currentRoundNo],
  );
  return rows[0];
}

/** @returns {Promise<boolean>} false when the idempotency key was already used */
async function insertAction(db, { sessionId, roundId, roomPlayerId, actionType, payload, idempotencyKey, version }) {
  const { rowCount } = await db.query(
    `INSERT INTO game_actions (session_id, round_id, room_player_id, action_type, payload, idempotency_key, state_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) ON CONFLICT DO NOTHING`,
    [sessionId, roundId, roomPlayerId, actionType, JSON.stringify(payload), idempotencyKey, version],
  );
  return rowCount === 1;
}

/** game_history ------------------------------------------------------------ */

async function insertHistory(db, { sessionId, roomId, winnerUserId, totalRounds, finalScoreboard, eliminatedHistory, startedAt }) {
  await db.query(
    `INSERT INTO game_history (session_id, room_id, winner_user_id, total_rounds, final_scoreboard, eliminated_history, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now()) ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, roomId, winnerUserId, totalRounds, JSON.stringify(finalScoreboard), JSON.stringify(eliminatedHistory), startedAt],
  );
}

/** read models ------------------------------------------------------------- */

async function isParticipant(db, { sessionId, userId }) {
  const { rows } = await db.query(
    `SELECT 1 FROM game_sessions s JOIN room_players rp ON rp.room_id = s.room_id
      WHERE s.id = $1 AND rp.user_id = $2`,
    [sessionId, userId],
  );
  return rows.length > 0;
}

async function loadScoreHistory(db, sessionId) {
  const { rows } = await db.query(
    `SELECT gr.round_no, gr.end_reason, gr.ended_at, ps.penalty, ps.reason, ps.cumulative_after, ps.eliminated_now,
            rp.user_id, u.nickname, (gr.winner_player_id = rp.id) AS is_round_winner
       FROM game_rounds gr
       JOIN player_scores ps ON ps.round_id = gr.id
       JOIN room_players rp ON rp.id = ps.room_player_id
       JOIN users u ON u.id = rp.user_id
      WHERE gr.session_id = $1
      ORDER BY gr.round_no, rp.seat_no`,
    [sessionId],
  );
  const rounds = new Map();
  for (const r of rows) {
    if (!rounds.has(r.round_no)) rounds.set(r.round_no, { roundNo: r.round_no, endReason: r.end_reason, endedAt: r.ended_at, scores: [] });
    rounds.get(r.round_no).scores.push({
      playerId: r.user_id,
      nickname: r.nickname,
      penalty: r.penalty,
      reason: r.reason,
      cumulativeScore: r.cumulative_after,
      eliminated: r.eliminated_now,
      isRoundWinner: Boolean(r.is_round_winner),
    });
  }
  return [...rounds.values()];
}

module.exports = {
  insertSession, saveSnapshot, completeSession, loadLiveSessions, purgeSessionDetails, purgeOldRooms,
  insertRound, findRoundId, completeRound, insertRoundPlayers, updateRoundPlayers, replaceRoundCards,
  insertScores, updateRoomPlayerTotals, recordAction, insertAction, insertHistory, isParticipant, loadScoreHistory,
};
