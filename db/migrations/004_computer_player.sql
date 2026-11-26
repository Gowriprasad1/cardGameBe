-- 004_computer_player.sql : "mawa", the computer player for single-player games.
-- Each solo room gets its own computer user, marked here so a restart knows who plays itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_migrations (version) VALUES ('004_computer_player') ON CONFLICT DO NOTHING;
