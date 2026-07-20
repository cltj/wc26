UPDATE leagues SET season_start_month = 8, season_span_months = 10 WHERE espn_code IN (
  'ENG.1','ENG.2','ESP.1','ESP.2','GER.1','GER.2','ITA.1','ITA.2',
  'FRA.1','FRA.2','NED.1','POR.1','BEL.1','TUR.1','AUT.1','GRE.1',
  'SCO.1','RUS.1','KSA.1',
  'UEFA.CHAMPIONS','UEFA.EUROPA','UEFA.EUROPA.CONF',
  'CAF.CHAMPIONS','CAF.CONFED','AFC.CHAMPIONS','AFC.CUP',
  'ENG.FA','ENG.LEAGUE_CUP','ESP.COPA_DEL_REY','GER.DFB_POKAL',
  'ITA.COPPA_ITALIA','FRA.COUPE_DE_FRANCE','NED.CUP','SCO.TENNENTS'
);

UPDATE leagues SET season_start_month = 7, season_span_months = 2 WHERE espn_code IN (
  'UEFA.CHAMPIONS_QUAL','UEFA.EUROPA_QUAL','UEFA.EUROPA.CONF_QUAL'
);

UPDATE leagues SET season_start_month = 10, season_span_months = 7 WHERE espn_code IN (
  'AUS.1','IND.1','RSA.1'
);

UPDATE leagues SET season_start_month = 7, season_span_months = 10 WHERE espn_code IN (
  'DEN.1'
);

UPDATE leagues SET season_start_month = 4, season_span_months = 8 WHERE espn_code IN (
  'NOR.1','SWE.1'
);

UPDATE leagues SET season_start_month = 2, season_span_months = 10 WHERE espn_code IN (
  'USA.1','ARG.1','CHI.1','COL.1','URU.1','PER.1','PAR.1','ECU.1',
  'CONMEBOL.LIBERTADORES','CONMEBOL.SUDAMERICANA','CONCACAF.CHAMPIONS',
  'BRA.COPA_DO_BRAZIL'
);

UPDATE leagues SET season_start_month = 3, season_span_months = 9 WHERE espn_code IN (
  'BRA.1','BRA.2','JPN.1','CHN.1'
);

UPDATE leagues SET season_start_month = 7, season_span_months = 11 WHERE espn_code IN (
  'MEX.1'
);

UPDATE leagues SET season_start_month = 7, season_span_months = 2 WHERE espn_code IN (
  'CONCACAF.LEAGUES.CUP'
);

UPDATE leagues SET season_start_month = NULL WHERE espn_code IN (
  'FIFA.WORLD','FIFA.WORLD.U17','FIFA.WORLD.U20','FIFA.OLYMPICS',
  'FIFA.CWC','FIFA.INTERCONTINENTAL_CUP',
  'UEFA.SUPER_CUP','CONMEBOL.RECOPA','GLOBAL.FINALISSIMA',
  'UEFA.EURO','UEFA.EURO_U21','CONMEBOL.AMERICA',
  'CONCACAF.GOLD','CONCACAF.NATIONS.LEAGUE',
  'CAF.NATIONS','CAF.CHAMPIONSHIP','AFC.ASIAN.CUP',
  'FIFA.FRIENDLY','NONFIFA','CLUB.FRIENDLY',
  'FIFA.WORLDQ.UEFA','FIFA.WORLDQ.CONMEBOL','FIFA.WORLDQ.CONCACAF',
  'FIFA.WORLDQ.AFC','FIFA.WORLDQ.CAF','FIFA.WORLDQ.OFC','FIFA.WCQ.PLY',
  'UEFA.EUROQ','UEFA.EURO_U21_QUAL','CONCACAF.GOLD_QUAL',
  'CAF.NATIONS_QUAL','AFC.CUPQ'
);
