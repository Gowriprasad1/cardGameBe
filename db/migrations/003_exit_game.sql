-- 003_exit_game.sql : a player can leave a game in progress (the Exit button).
-- Their seat is kept for the results (room_players.status already allows 'left');
-- the round they leave records them as 'left', with a 'left' score row worth 0 points.

ALTER TABLE round_players DROP CONSTRAINT IF EXISTS round_players_status_check;
ALTER TABLE round_players ADD CONSTRAINT round_players_status_check
  CHECK (status IN ('playing', 'dropped_first', 'dropped_middle', 'removed_invalid_declaration', 'winner', 'left'));

ALTER TABLE player_scores DROP CONSTRAINT IF EXISTS player_scores_reason_check;
ALTER TABLE player_scores ADD CONSTRAINT player_scores_reason_check
  CHECK (reason IN ('winner', 'unmatched_cards', 'no_life_hand', 'first_drop', 'middle_drop',
                    'invalid_declaration', 'no_penalty', 'no_pure_sequence', 'left'));

INSERT INTO schema_migrations (version) VALUES ('003_exit_game') ON CONFLICT DO NOTHING;
