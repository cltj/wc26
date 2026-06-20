-- Migration: Add player_matches table + new columns on players
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard/project/hsanauyxexbyefmefhcd/sql)

-- 1. Add new columns to players table
ALTER TABLE players ADD COLUMN IF NOT EXISTS fifa_position text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS espn_position text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS matches_played integer DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS espn_id text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS image_url text;

-- Copy current position → fifa_position (one-time backfill)
UPDATE players SET fifa_position = position WHERE fifa_position IS NULL AND position IS NOT NULL;

-- 2. Create player_matches table
CREATE TABLE IF NOT EXISTS player_matches (
  id serial PRIMARY KEY,
  player_id integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id bigint NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  started boolean DEFAULT false,
  subbed_in boolean DEFAULT false,
  subbed_out boolean DEFAULT false,
  sub_minute text,
  replaced_player_id integer REFERENCES players(id),
  position text,
  goals jsonb DEFAULT '[]'::jsonb,
  assists jsonb DEFAULT '[]'::jsonb,
  yellow_card text,
  red_card text,
  formation_place integer,
  created_at timestamptz DEFAULT now(),
  UNIQUE(player_id, game_id)
);

-- 3. Enable RLS (match the pattern of other tables)
ALTER TABLE player_matches ENABLE ROW LEVEL SECURITY;

-- Allow anon read access
CREATE POLICY "Allow anon read" ON player_matches
  FOR SELECT USING (true);

-- Allow service role full access
CREATE POLICY "Allow service role all" ON player_matches
  FOR ALL USING (true) WITH CHECK (true);

-- 4. Index for common queries
CREATE INDEX IF NOT EXISTS idx_player_matches_game ON player_matches(game_id);
CREATE INDEX IF NOT EXISTS idx_player_matches_player ON player_matches(player_id);
