'use strict';

async function insertGuest(db, { nickname, tokenHash }) {
  const { rows } = await db.query(
    'INSERT INTO users (nickname, token_hash) VALUES ($1, $2) RETURNING id, nickname',
    [nickname, tokenHash],
  );
  return rows[0];
}

/**
 * A computer player for one room. Its token is random and never handed out,
 * so nobody can sign in as it.
 */
async function insertBot(db, { nickname }) {
  const { rows } = await db.query(
    "INSERT INTO users (nickname, token_hash, is_bot) VALUES ($1, 'bot:' || gen_random_uuid()::text, TRUE) RETURNING id, nickname",
    [nickname],
  );
  return rows[0];
}

async function findByTokenHash(db, tokenHash) {
  const { rows } = await db.query('SELECT id, nickname FROM users WHERE token_hash = $1', [tokenHash]);
  return rows[0] || null;
}

async function touch(db, userId) {
  await db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
}

/**
 * Delete guests who have not been seen for `days` days and never played
 * (they have no seat, room or result that refers to them).
 * @returns {Promise<number>} how many were removed
 */
async function purgeStaleGuests(db, days) {
  const { rowCount } = await db.query(
    `DELETE FROM users u
      WHERE u.last_seen_at < now() - ($1::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM room_players rp WHERE rp.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM game_rooms r WHERE r.host_user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM game_history h WHERE h.winner_user_id = u.id)`,
    [days],
  );
  return rowCount;
}

module.exports = { insertGuest, insertBot, findByTokenHash, touch, purgeStaleGuests };
