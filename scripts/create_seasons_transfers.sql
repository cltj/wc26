CREATE TABLE IF NOT EXISTS seasons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  league_id bigint NOT NULL REFERENCES leagues(id),
  label text NOT NULL,
  start_date date,
  end_date date,
  is_current boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(league_id, label)
);

ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "seasons_read" ON seasons FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS transfers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id integer NOT NULL REFERENCES players(id),
  from_club_id bigint REFERENCES club_teams(id),
  to_club_id bigint REFERENCES club_teams(id),
  detected_at timestamptz NOT NULL DEFAULT now(),
  transfer_date date,
  season_id bigint REFERENCES seasons(id),
  type text DEFAULT 'unknown',
  fee_eur numeric,
  notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "transfers_read" ON transfers FOR SELECT USING (true);

CREATE INDEX idx_transfers_player ON transfers(player_id);
CREATE INDEX idx_transfers_detected ON transfers(detected_at DESC);
CREATE INDEX idx_transfers_clubs ON transfers(from_club_id, to_club_id);

ALTER TABLE national_squads ADD COLUMN IF NOT EXISTS season_id bigint REFERENCES seasons(id);
