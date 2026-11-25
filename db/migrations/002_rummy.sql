-- 002_rummy.sql : add the Indian Rummy game and the score reason it needs.

INSERT INTO game_types (code, name, min_players, max_players, default_config)
VALUES ('RUMMY', 'Indian Rummy', 2, 5, '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- A player with no pure sequence is counted in full; that gets its own reason.
ALTER TABLE player_scores DROP CONSTRAINT IF EXISTS player_scores_reason_check;
ALTER TABLE player_scores ADD CONSTRAINT player_scores_reason_check
  CHECK (reason IN ('winner', 'unmatched_cards', 'no_life_hand', 'first_drop', 'middle_drop',
                    'invalid_declaration', 'no_penalty', 'no_pure_sequence'));

INSERT INTO schema_migrations (version) VALUES ('002_rummy') ON CONFLICT DO NOTHING;
