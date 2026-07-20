ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_start_month int;
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_start_day int DEFAULT 1;
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_span_months int DEFAULT 10;

COMMENT ON COLUMN leagues.season_start_month IS 'Month the season typically starts (1-12). NULL for irregular competitions.';
COMMENT ON COLUMN leagues.season_span_months IS 'How many months the season spans. 10 = Aug-May style, 8 = Feb-Oct style, 1 = tournament.';
