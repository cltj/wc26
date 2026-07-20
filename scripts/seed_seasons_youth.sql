INSERT INTO seasons (league_id, label, start_date, end_date, is_current) VALUES
(4, '2025', '2025-09-27', '2025-10-19', false),
(5, '2025', '2025-11-14', '2025-12-07', false)
ON CONFLICT (league_id, label) DO NOTHING;
