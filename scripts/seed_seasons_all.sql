INSERT INTO seasons (league_id, label, start_date, end_date, is_current) VALUES
-- Continental club competitions (2025-26 editions)
(31, '2025-26', '2025-09-17', '2026-05-30', true),  -- UEFA Champions League
(32, '2025-26', '2025-07-08', '2025-08-28', false),  -- UEFA CL Qualifying (finished)
(33, '2025-26', '2025-09-25', '2026-05-27', true),  -- UEFA Europa League
(34, '2025-26', '2025-07-11', '2025-08-29', false),  -- UEFA EL Qualifying (finished)
(35, '2025-26', '2025-10-03', '2026-05-27', true),  -- UEFA Conference League
(36, '2025-26', '2025-07-11', '2025-08-29', false),  -- UEFA ECL Qualifying (finished)
(37, '2025-26', '2025-08-13', '2025-08-13', false),  -- UEFA Super Cup (one-off)
(38, '2026', '2026-02-11', '2026-11-28', true),     -- CONMEBOL Libertadores
(39, '2026', '2026-03-04', '2026-11-21', true),     -- CONMEBOL Sudamericana
(40, '2026', '2026-02-19', '2026-02-19', false),    -- CONMEBOL Recopa (one-off)
(41, '2026', '2026-02-18', '2026-05-28', true),     -- Concacaf Champions Cup
(42, '2026', '2026-07-29', '2026-08-24', false),    -- Leagues Cup (summer)
(43, '2025-26', '2025-09-13', '2026-05-24', true),  -- CAF Champions League
(44, '2025-26', '2025-09-13', '2026-05-24', true),  -- CAF Confederation Cup
(45, '2025-26', '2025-09-16', '2026-05-03', true),  -- AFC Champions League Elite
(46, '2025-26', '2025-09-17', '2026-04-26', true),  -- AFC Champions League Two
(47, '2025-26', '2025-07-01', '2026-06-30', true),  -- Club Friendly (year-round)
(29, '2025', '2025-06-15', '2025-07-13', false),    -- FIFA Club World Cup 2025
(30, '2025', '2025-12-10', '2025-12-17', false),    -- FIFA Intercontinental Cup 2025

-- Domestic cups (2025-26 editions)
(86, '2025-26', '2025-08-10', '2026-05-23', true),  -- English FA Cup
(87, '2025-26', '2025-08-13', '2026-03-16', true),  -- English Carabao Cup
(88, '2025-26', '2025-10-29', '2026-04-25', true),  -- Spanish Copa del Rey
(89, '2025-26', '2025-08-16', '2026-05-24', true),  -- German Cup (DFB-Pokal)
(90, '2025-26', '2025-08-11', '2026-05-14', true),  -- Coppa Italia
(91, '2025-26', '2025-09-21', '2026-05-06', true),  -- Coupe de France
(92, '2025-26', '2025-09-24', '2026-04-19', true),  -- Dutch KNVB Beker
(93, '2025-26', '2025-10-26', '2026-05-16', true),  -- Scottish Cup
(94, '2026', '2026-02-19', '2026-11-04', true),     -- Copa do Brasil

-- International tournaments (current or upcoming editions)
(2, '2025-26', '2025-09-01', '2026-06-30', true),   -- International Friendly (ongoing window)
(3, '2028', NULL, NULL, false),                       -- Olympics (next: 2028 LA)
(6, '2028', NULL, NULL, false),                       -- UEFA Euro (next: 2028)
(7, '2025-26', '2025-09-04', '2026-06-08', true),   -- UEFA Nations League
(8, '2025', '2025-06-11', '2025-06-28', false),     -- UEFA Euro U21
(9, '2028', NULL, NULL, false),                       -- Copa America (next: 2028)
(10, '2027', NULL, NULL, false),                      -- Concacaf Gold Cup (next: 2027)
(11, '2025-26', '2025-09-04', '2026-03-25', true),  -- Concacaf Nations League
(12, '2025', '2025-12-21', '2026-02-01', true),     -- Africa Cup of Nations 2025
(13, '2025', NULL, NULL, false),                      -- African Nations Championship
(14, '2027', NULL, NULL, false),                      -- AFC Asian Cup (next: 2027)
(15, '2025-26', '2025-07-01', '2026-06-30', true),  -- Non-FIFA Friendly
(16, '2025', NULL, NULL, false),                      -- CONMEBOL-UEFA Finalissima

-- International qualifying
(17, '2025-26', '2025-09-04', '2026-03-31', true),  -- WCQ UEFA
(18, '2025-26', '2025-09-04', '2025-09-09', false),  -- WCQ CONMEBOL (finished)
(19, '2025-26', '2025-06-04', '2025-11-18', false),  -- WCQ Concacaf (finished)
(20, '2025-26', '2025-03-20', '2025-06-10', false),  -- WCQ AFC (finished)
(21, '2025-26', '2025-03-20', '2025-11-18', false),  -- WCQ CAF (finished)
(22, '2025-26', '2025-03-20', '2025-11-18', false),  -- WCQ OFC (finished)
(23, '2025-26', '2026-03-12', '2026-03-25', false),  -- WCQ Playoff
(24, '2028', NULL, NULL, false),                      -- Euro Qualifying (next cycle)
(25, '2025', '2025-09-03', '2025-10-14', false),     -- UEFA Euro U21 Qualifying
(26, '2027', NULL, NULL, false),                      -- Gold Cup Qualifying
(27, '2025', '2024-09-04', '2025-11-18', false),     -- AFCON Qualifying
(28, '2027', NULL, NULL, false)                       -- AFC Asian Cup Qualifiers
ON CONFLICT (league_id, label) DO UPDATE SET
  start_date = EXCLUDED.start_date,
  end_date = EXCLUDED.end_date,
  is_current = EXCLUDED.is_current;
