-- 001_init.sql : initial schema for the multiplayer card platform (SET game first)
-- Target: Neon PostgreSQL (13+). Run inside a transaction by the migration runner.
-- Points are virtual entertainment points only. No monetary columns exist anywhere.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- users: guest players. The raw token lives only in the browser; we store a hash.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname      VARCHAR(30) NOT NULL CHECK (char_length(btrim(nickname)) BETWEEN 2 AND 30),
  token_hash    TEXT NOT NULL UNIQUE,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- game_types: lets us add more card games later without schema changes.
-- ---------------------------------------------------------------------------
CREATE TABLE game_types (
  id              SMALLSERIAL PRIMARY KEY,
  code            VARCHAR(30) NOT NULL UNIQUE,
  name            VARCHAR(60) NOT NULL,
  min_players     SMALLINT NOT NULL CHECK (min_players >= 1),
  max_players     SMALLINT NOT NULL CHECK (max_players >= min_players),
  default_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- game_rooms: lobby + lifecycle (waiting -> in_progress -> finished | abandoned)
-- ---------------------------------------------------------------------------
CREATE TABLE game_rooms (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code      VARCHAR(8) NOT NULL UNIQUE CHECK (room_code ~ '^[A-Z0-9]{4,8}$'),
  game_type_id   SMALLINT NOT NULL REFERENCES game_types(id),
  host_user_id   UUID NOT NULL REFERENCES users(id),
  status         VARCHAR(16) NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting', 'in_progress', 'finished', 'abandoned')),
  max_players    SMALLINT NOT NULL DEFAULT 5 CHECK (max_players BETWEEN 2 AND 5),
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_game_rooms_status ON game_rooms (status);
CREATE INDEX idx_game_rooms_host ON game_rooms (host_user_id);

-- ---------------------------------------------------------------------------
-- room_players: seat + cumulative score + elimination state
-- A user can appear only once per room, and a seat only once per room.
-- ---------------------------------------------------------------------------
CREATE TABLE room_players (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id              UUID NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id),
  seat_no              SMALLINT NOT NULL CHECK (seat_no BETWEEN 0 AND 4),
  status               VARCHAR(16) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'eliminated', 'left')),
  cumulative_score     INTEGER NOT NULL DEFAULT 0 CHECK (cumulative_score >= 0),
  total_drops          SMALLINT NOT NULL DEFAULT 0 CHECK (total_drops >= 0),
  is_connected         BOOLEAN NOT NULL DEFAULT TRUE,
  eliminated_at        TIMESTAMPTZ,
  eliminated_round_no  INTEGER,
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id),
  UNIQUE (room_id, seat_no),
  CHECK ((status = 'eliminated') = (eliminated_at IS NOT NULL))
);
CREATE INDEX idx_room_players_user ON room_players (user_id);

-- ---------------------------------------------------------------------------
-- game_sessions: one game (many rounds) played inside a room.
-- state_snapshot is the authoritative engine state used for crash recovery.
-- It contains private data and must never be returned by any API.
-- ---------------------------------------------------------------------------
CREATE TABLE game_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id            UUID NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  game_type_id       SMALLINT NOT NULL REFERENCES game_types(id),
  status             VARCHAR(16) NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  config             JSONB NOT NULL,
  deck_count         SMALLINT NOT NULL CHECK (deck_count IN (1, 2)),
  current_round_no   INTEGER NOT NULL DEFAULT 0,
  first_dealer_id    UUID REFERENCES room_players(id),
  winner_player_id   UUID REFERENCES room_players(id),
  state_version      BIGINT NOT NULL DEFAULT 0,
  state_snapshot     JSONB,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only one live session per room.
CREATE UNIQUE INDEX uq_game_sessions_one_live_per_room
  ON game_sessions (room_id) WHERE status = 'in_progress';

-- ---------------------------------------------------------------------------
-- game_rounds
-- ---------------------------------------------------------------------------
CREATE TABLE game_rounds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  round_no           INTEGER NOT NULL CHECK (round_no >= 1),
  dealer_player_id   UUID NOT NULL REFERENCES room_players(id),
  open_joker_rank    VARCHAR(2) NOT NULL
                     CHECK (open_joker_rank IN ('A','2','3','4','5','6','7','8','9','10','J','Q','K')),
  status             VARCHAR(16) NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress', 'completed')),
  winner_player_id   UUID REFERENCES room_players(id),
  end_reason         VARCHAR(24)
                     CHECK (end_reason IN ('valid_declaration', 'last_player_standing', 'invalid_declaration_end', 'abandoned')),
  turn_no            INTEGER NOT NULL DEFAULT 0,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, round_no),
  CHECK ((status = 'completed') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_game_rounds_one_live_per_session
  ON game_rounds (session_id) WHERE status = 'in_progress';

-- ---------------------------------------------------------------------------
-- round_players: each player's state inside one round
-- ---------------------------------------------------------------------------
CREATE TABLE round_players (
  round_id             UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  room_player_id       UUID NOT NULL REFERENCES room_players(id),
  turn_order           SMALLINT NOT NULL CHECK (turn_order BETWEEN 0 AND 4),
  status               VARCHAR(32) NOT NULL DEFAULT 'playing'
                       CHECK (status IN ('playing', 'dropped_first', 'dropped_middle', 'removed_invalid_declaration', 'winner')),
  turns_taken          INTEGER NOT NULL DEFAULT 0 CHECK (turns_taken >= 0),
  consecutive_timeouts SMALLINT NOT NULL DEFAULT 0,
  one_card_to_win      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, room_player_id),
  UNIQUE (round_id, turn_order)
);

-- ---------------------------------------------------------------------------
-- card_decks: every physical card of a round (identity + pile location).
-- instance_id is unique per round, which prevents duplicate physical cards.
-- Server only. Never exposed through REST or Socket.IO.
-- ---------------------------------------------------------------------------
CREATE TABLE card_decks (
  round_id         UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  instance_id      VARCHAR(12) NOT NULL,
  deck_no          SMALLINT NOT NULL CHECK (deck_no IN (1, 2)),
  suit             CHAR(1) CHECK (suit IN ('H', 'D', 'C', 'S')),
  rank             VARCHAR(2) CHECK (rank IN ('A','2','3','4','5','6','7','8','9','10','J','Q','K')),
  is_printed_joker BOOLEAN NOT NULL DEFAULT FALSE,
  location         VARCHAR(12) NOT NULL
                   CHECK (location IN ('draw', 'discard', 'open_joker', 'hand')),
  pile_position    INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, instance_id),
  CHECK ((is_printed_joker AND suit IS NULL AND rank IS NULL)
      OR (NOT is_printed_joker AND suit IS NOT NULL AND rank IS NOT NULL)),
  CHECK ((location IN ('draw', 'discard')) = (pile_position IS NOT NULL))
);
-- A pile slot can hold only one card.
CREATE UNIQUE INDEX uq_card_decks_pile_slot
  ON card_decks (round_id, location, pile_position) WHERE pile_position IS NOT NULL;

-- ---------------------------------------------------------------------------
-- player_cards: private hands and each player's arrangement (group + order).
-- A card can be in only one hand (PK on round + card).
-- ---------------------------------------------------------------------------
CREATE TABLE player_cards (
  round_id         UUID NOT NULL,
  instance_id      VARCHAR(12) NOT NULL,
  room_player_id   UUID NOT NULL REFERENCES room_players(id),
  group_no         SMALLINT,
  sort_order       SMALLINT NOT NULL DEFAULT 0,
  acquired_via     VARCHAR(12) NOT NULL DEFAULT 'deal'
                   CHECK (acquired_via IN ('deal', 'draw_pile', 'discard_pile')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, instance_id),
  FOREIGN KEY (round_id, instance_id) REFERENCES card_decks (round_id, instance_id) ON DELETE CASCADE,
  FOREIGN KEY (round_id, room_player_id) REFERENCES round_players (round_id, room_player_id) ON DELETE CASCADE
);
CREATE INDEX idx_player_cards_owner ON player_cards (round_id, room_player_id);

-- ---------------------------------------------------------------------------
-- game_actions: append-only audit log. The idempotency key stops duplicate
-- draws, discards, drops and declarations being applied twice.
-- ---------------------------------------------------------------------------
CREATE TABLE game_actions (
  id               BIGSERIAL PRIMARY KEY,
  session_id       UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  round_id         UUID REFERENCES game_rounds(id) ON DELETE CASCADE,
  room_player_id   UUID REFERENCES room_players(id),
  action_type      VARCHAR(32) NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  VARCHAR(64),
  state_version    BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_game_actions_session ON game_actions (session_id, id);
CREATE UNIQUE INDEX uq_game_actions_idempotency
  ON game_actions (session_id, room_player_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- player_scores: exactly one row per player per round. The unique key is what
-- makes "never apply two penalties in one round" and "no duplicate score
-- update" structurally impossible.
-- ---------------------------------------------------------------------------
CREATE TABLE player_scores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  round_id          UUID NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  room_player_id    UUID NOT NULL REFERENCES room_players(id),
  reason            VARCHAR(24) NOT NULL
                    CHECK (reason IN ('winner', 'unmatched_cards', 'no_life_hand', 'first_drop', 'middle_drop', 'invalid_declaration', 'no_penalty')),
  penalty           INTEGER NOT NULL CHECK (penalty >= 0),
  unmatched_cards   JSONB NOT NULL DEFAULT '[]'::jsonb,
  cumulative_after  INTEGER NOT NULL CHECK (cumulative_after >= 0),
  eliminated_now    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, room_player_id)
);
CREATE INDEX idx_player_scores_session ON player_scores (session_id, round_id);

-- ---------------------------------------------------------------------------
-- game_history: immutable summary written once when a session completes.
-- ---------------------------------------------------------------------------
CREATE TABLE game_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID NOT NULL UNIQUE REFERENCES game_sessions(id) ON DELETE CASCADE,
  room_id               UUID NOT NULL REFERENCES game_rooms(id),
  winner_user_id        UUID REFERENCES users(id),
  total_rounds          INTEGER NOT NULL CHECK (total_rounds >= 0),
  final_scoreboard      JSONB NOT NULL,
  eliminated_history    JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at            TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_game_history_winner ON game_history (winner_user_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','game_types','game_rooms','room_players','game_sessions','game_rounds',
    'round_players','card_decks','player_cards','player_scores','game_history'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- seed
-- ---------------------------------------------------------------------------
INSERT INTO game_types (code, name, min_players, max_players, default_config)
VALUES ('SET', 'Set Game', 2, 5, '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('001_init') ON CONFLICT DO NOTHING;
