// ── Shared group standings computation ────────────────────────────────────────
// Used by groups.html and bracket.html

// Map schedule team names (worldcup26.ir) → teams table names
const SCHED_TO_TEAM = {
  'Korea Republic': 'South Korea',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Ivory Coast': "Côte d'Ivoire",
  'Iran': 'IR Iran',
  'Cape Verde': 'Cabo Verde',
  'Democratic Republic of the Congo': 'DR Congo',
  'Congo DR': 'DR Congo',
  'United States': 'USA',
  'Turkey': 'Türkiye',
  'Czech Republic': 'Czechia',
};

function normalizeTeamName(name) {
  return SCHED_TO_TEAM[name] || name;
}

// Compute group standings from teams + schedule data
// Returns { A: [{name,pld,w,d,l,gf,ga,pts}, ...], B: [...], ... }
function computeStandings(teams, schedule) {
  // Init stats for every team
  const stats = {};
  teams.forEach(t => {
    stats[t.name] = { name: t.name, group: t.group_letter, pld:0, w:0, d:0, l:0, gf:0, ga:0, pts:0 };
  });

  // Process finished group-stage matches
  schedule.forEach(m => {
    if (m.status !== 'FT') return;
    if (!m.group_name || !m.group_name.startsWith('Group')) return;
    const home = normalizeTeamName(m.home_team);
    const away = normalizeTeamName(m.away_team);
    const hs = m.home_score ?? 0, as = m.away_score ?? 0;

    if (!stats[home] || !stats[away]) return;

    stats[home].pld++; stats[away].pld++;
    stats[home].gf += hs; stats[home].ga += as;
    stats[away].gf += as; stats[away].ga += hs;

    if (hs > as) {
      stats[home].w++; stats[home].pts += 3;
      stats[away].l++;
    } else if (hs < as) {
      stats[away].w++; stats[away].pts += 3;
      stats[home].l++;
    } else {
      stats[home].d++; stats[home].pts += 1;
      stats[away].d++; stats[away].pts += 1;
    }
  });

  // Group teams by letter and sort within each group
  const groups = {};
  Object.values(stats).forEach(t => {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push(t);
  });

  const sortTeams = arr => arr.sort((a, b) =>
    (b.pts - a.pts) || ((b.gf - b.ga) - (a.gf - a.ga)) || (b.gf - a.gf)
  );

  Object.keys(groups).forEach(g => sortTeams(groups[g]));
  return groups;
}

// Get 8 best 3rd-place teams across all 12 groups
// Returns array of team stat objects, sorted best to worst
function bestThirdPlaces(groups) {
  const thirds = [];
  Object.entries(groups).forEach(([letter, teams]) => {
    if (teams.length >= 3) {
      thirds.push({ ...teams[2], fromGroup: letter });
    }
  });
  // Sort: pts desc, GD desc, GF desc
  thirds.sort((a, b) =>
    (b.pts - a.pts) || ((b.gf - b.ga) - (a.gf - a.ga)) || (b.gf - a.gf)
  );
  return thirds;
}

// Determine which 3rd-place teams qualify (top 8)
// Returns Set of group letters whose 3rd-place team qualifies
function qualifyingThirdGroups(groups) {
  const thirds = bestThirdPlaces(groups);
  const qualifying = new Set();
  thirds.slice(0, 8).forEach(t => qualifying.add(t.fromGroup));
  return qualifying;
}

// FIFA 2026 R32 bracket structure (ordered for proper R16 pairings)
// Adjacent matches feed into the same R16 match:
// M74+M77→R16, M73+M75→R16, M76+M78→R16, M79+M80→R16,
// M83+M84→R16, M81+M82→R16, M86+M88→R16, M85+M87→R16
// Slots per FIFA official bracket (post-group stage determination)
const R32_STRUCTURE = [
  { top: '1st E', bot: '3rd A/B/C/D/F', date: '29 Jun' },   // M74: Germany vs Paraguay
  { top: '1st I', bot: '3rd C/D/F/G/H', date: '30 Jun' },   // M77: France vs Sweden
  { top: '2nd A', bot: '2nd B', date: '28 Jun' },           // M73: South Africa vs Canada
  { top: '1st F', bot: '2nd C', date: '29 Jun' },           // M75: Netherlands vs Morocco
  { top: '1st C', bot: '2nd F', date: '29 Jun' },           // M76: Brazil vs Japan
  { top: '2nd E', bot: '2nd I', date: '30 Jun' },           // M78: Ivory Coast vs Norway
  { top: '1st A', bot: '3rd C/E', date: '30 Jun' },         // M79: Mexico vs 3rd C/E
  { top: '1st L', bot: '3rd I/J/K', date: '1 Jul' },        // M80: England vs 3rd I/J/K
  { top: '2nd K', bot: '2nd L', date: '2 Jul' },            // M83: Colombia vs Ghana
  { top: '1st H', bot: '2nd J', date: '2 Jul' },            // M84: Spain vs Austria
  { top: '1st D', bot: '3rd B/E/F/I/J', date: '1 Jul' },    // M81: USA vs Bosnia
  { top: '1st G', bot: '3rd A/I/J', date: '1 Jul' },        // M82: Belgium vs 3rd A/I/J
  { top: '1st J', bot: '2nd H', date: '3 Jul' },            // M86: Argentina vs Cape Verde
  { top: '2nd D', bot: '2nd G', date: '3 Jul' },            // M88: Australia vs Egypt
  { top: '1st B', bot: '3rd G/J', date: '2 Jul' },          // M85: Switzerland vs 3rd G/J
  { top: '1st K', bot: '3rd E/I/L', date: '3 Jul' },        // M87: Portugal vs 3rd E/I/L
];

// Resolve a bracket slot label to a team name
// e.g. '1st A' → 'Mexico', '2nd B' → 'Qatar', '3rd A/B/C/D/F' → team or null
function resolveSlot(label, groups, qualThirdGroups) {
  const m1 = label.match(/^(1st|2nd)\s+([A-L])$/);
  if (m1) {
    const pos = m1[1] === '1st' ? 0 : 1;
    const grp = groups[m1[2]];
    if (!grp || grp.length < 2) return null;
    // Only resolve if the group has had at least some matches
    if (grp[0].pld === 0) return null;
    return grp[pos].name;
  }

  const m3 = label.match(/^3rd\s+(.+)$/);
  if (m3) {
    const possibleGroups = m3[1].split('/');
    // Find which of the possible groups has a qualifying 3rd-place team
    const matching = possibleGroups.filter(g => qualThirdGroups.has(g));
    if (matching.length === 1) {
      return groups[matching[0]][2]?.name || null;
    }
    // Can't determine yet — multiple possibilities or none
    return null;
  }
  return null;
}
