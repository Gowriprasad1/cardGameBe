'use strict';

async function getGameTypeId(db, code) {
  const { rows } = await db.query('SELECT id FROM game_types WHERE code = $1 AND is_active', [code]);
  return rows[0] ? rows[0].id : null;
}

async function insertRoom(db, { roomCode, gameTypeId, hostUserId, maxPlayers }) {
  const { rows } = await db.query(
    `INSERT INTO game_rooms (room_code, game_type_id, host_user_id, max_players)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [roomCode, gameTypeId, hostUserId, maxPlayers],
  );
  return rows[0].id;
}

async function insertRoomPlayer(db, { roomId, userId, seatNo }) {
  const { rows } = await db.query(
    'INSERT INTO room_players (room_id, user_id, seat_no) VALUES ($1, $2, $3) RETURNING id',
    [roomId, userId, seatNo],
  );
  return rows[0].id;
}

async function deleteRoomPlayer(db, { roomId, userId }) {
  await db.query('DELETE FROM room_players WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
}

async function setHost(db, { roomId, hostUserId }) {
  await db.query('UPDATE game_rooms SET host_user_id = $2 WHERE id = $1', [roomId, hostUserId]);
}

async function setRoomStatus(db, { roomId, status }) {
  await db.query(
    `UPDATE game_rooms SET status = $2::varchar,
       started_at = CASE WHEN $2::varchar = 'in_progress' THEN COALESCE(started_at, now()) ELSE started_at END,
       finished_at = CASE WHEN $2::varchar IN ('finished', 'abandoned') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [roomId, status],
  );
}

async function setConnected(db, { roomPlayerId, isConnected }) {
  await db.query('UPDATE room_players SET is_connected = $2 WHERE id = $1', [roomPlayerId, isConnected]);
}

/**
 * Rooms that are still open (waiting or in progress) with their players, used
 * to rebuild memory after a restart.
 */
async function loadOpenRooms(db) {
  const rooms = (await db.query(
    `SELECT r.id, r.room_code, r.host_user_id, r.status, r.max_players, g.code AS game_type
       FROM game_rooms r JOIN game_types g ON g.id = r.game_type_id
      WHERE r.status IN ('waiting', 'in_progress') ORDER BY r.created_at`,
  )).rows;
  if (rooms.length === 0) return [];
  const placeholders = rooms.map((_, i) => `$${i + 1}`).join(',');
  const players = (await db.query(
    `SELECT rp.id, rp.room_id, rp.user_id, rp.seat_no, rp.status, u.nickname
       FROM room_players rp JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id IN (${placeholders}) ORDER BY rp.seat_no`,
    rooms.map((r) => r.id),
  )).rows;
  return rooms.map((r) => ({ ...r, players: players.filter((p) => p.room_id === r.id) }));
}

module.exports = {
  getGameTypeId, insertRoom, insertRoomPlayer, deleteRoomPlayer, setHost, setRoomStatus, setConnected, loadOpenRooms,
};
