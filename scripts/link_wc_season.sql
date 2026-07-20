UPDATE national_squads ns
SET season_id = s.id
FROM seasons s
WHERE s.league_id = 1 AND s.label = 'WC 2026'
  AND ns.league_code = 'FIFA.WORLD'
  AND ns.season_id IS NULL;
