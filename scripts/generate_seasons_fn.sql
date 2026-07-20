CREATE OR REPLACE FUNCTION generate_seasons(from_year int DEFAULT 2020, to_year int DEFAULT 2026)
RETURNS TABLE(league_id bigint, label text, start_date date, end_date date, is_current boolean)
LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  yr int;
  s_start date;
  s_end date;
  s_label text;
  today date := current_date;
BEGIN
  FOR r IN SELECT l.id, l.season_start_month, l.season_span_months
           FROM leagues l
           WHERE l.season_start_month IS NOT NULL
  LOOP
    FOR yr IN from_year..to_year LOOP
      s_start := make_date(yr, r.season_start_month, 1);
      s_end   := (s_start + (r.season_span_months || ' months')::interval)::date;

      IF r.season_start_month >= 7 AND r.season_span_months > 6 THEN
        s_label := yr || '-' || right((yr+1)::text, 2);
      ELSE
        s_label := yr::text;
      END IF;

      is_current := today BETWEEN s_start AND s_end;

      RETURN QUERY SELECT r.id, s_label, s_start, s_end, is_current;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_seasons(from_year int DEFAULT 2020, to_year int DEFAULT 2026)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  inserted int := 0;
BEGIN
  INSERT INTO seasons (league_id, label, start_date, end_date, is_current)
  SELECT g.league_id, g.label, g.start_date, g.end_date, g.is_current
  FROM generate_seasons(from_year, to_year) g
  ON CONFLICT (league_id, label) DO UPDATE SET
    start_date = EXCLUDED.start_date,
    end_date = EXCLUDED.end_date,
    is_current = EXCLUDED.is_current;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;
