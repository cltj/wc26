import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const WC_API = 'https://worldcup26.ir'
const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world'

// Map worldcup26.ir team names → Supabase team names
const WC_TEAM_MAP: Record<string, string> = {
  'United States': 'USA',
  'Turkey': 'Türkiye',
  'Czech Republic': 'Czechia',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Ivory Coast': "Côte d'Ivoire",
  'Iran': 'IR Iran',
  'Cape Verde': 'Cabo Verde',
  'Democratic Republic of the Congo': 'DR Congo',
  'Korea Republic': 'South Korea',
}

// Map ESPN team names → Supabase team names
const ESPN_TEAM_MAP: Record<string, string> = {
  'United States': 'USA',
  'Türkiye': 'Türkiye',
  'Turkey': 'Türkiye',
  'Czechia': 'Czechia',
  'Czech Republic': 'Czechia',
  'Bosnia-Herzegovina': 'Bosnia & Herz.',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Ivory Coast': "Côte d'Ivoire",
  "Côte d'Ivoire": "Côte d'Ivoire",
  'Iran': 'IR Iran',
  'IR Iran': 'IR Iran',
  'Cape Verde': 'Cabo Verde',
  'Cabo Verde': 'Cabo Verde',
  'Congo DR': 'DR Congo',
  'DR Congo': 'DR Congo',
  'South Korea': 'South Korea',
  'Korea Republic': 'South Korea',
  'Curaçao': 'Curaçao',
  'Curacao': 'Curaçao',
}

function mapWcTeam(name: string): string {
  return WC_TEAM_MAP[name] || name
}

function mapEspnTeam(name: string): string {
  return ESPN_TEAM_MAP[name] || name
}

// Normalize for matching: strip diacritics + Scandinavian chars
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00f8/g, 'o').replace(/\u00d8/g, 'o')
    .replace(/\u00e6/g, 'ae').replace(/\u00c6/g, 'ae')
    .replace(/\u00e5/g, 'a').replace(/\u00c5/g, 'a')
    .replace(/\u00f0/g, 'd').replace(/\u00de/g, 'th')
    .replace(/\u00df/g, 'ss')
    .toLowerCase()
}

// Match an ESPN player name to a Supabase player — prefer multi-part matches over single last name
function matchPlayer(
  espnName: string, team: string,
  teamPlayers: Array<{ id: number, name: string, name_on_shirt: string | null }>
): number | null {
  const sNorm = norm(espnName)
  const sParts = sNorm.replace(/[.]/g, '').split(/\s+/).filter(Boolean)
  const sLast = sParts[sParts.length - 1] || ''
  const sFirst = sParts[0] || ''

  // Pass 1: strong matches (full name containment or multi-part)
  for (const pl of teamPlayers) {
    const pNorm = norm(pl.name)
    const pParts = pNorm.replace(/[.\-]/g, ' ').split(/\s+/).filter(Boolean)

    // Exact match
    if (sNorm === pNorm) return pl.id
    // Full containment
    if (pNorm.includes(sNorm) || sNorm.includes(pNorm)) return pl.id
    // All significant parts match (multi-part names)
    if (sParts.length >= 2) {
      const long = sParts.filter(p => p.length > 1)
      if (long.length > 0 && long.every(p => pParts.some(pp => pp === p || pp.startsWith(p)))) return pl.id
    }
    // Try shirt name — full match
    if (pl.name_on_shirt) {
      const shNorm = norm(pl.name_on_shirt)
      if (shNorm === sNorm || shNorm.includes(sNorm) || sNorm.includes(shNorm)) return pl.id
    }
  }

  // Pass 2: last-name-only match (weaker, only if first name also partially matches or single-word name)
  for (const pl of teamPlayers) {
    const pNorm = norm(pl.name)
    const pParts = pNorm.replace(/[.\-]/g, ' ').split(/\s+/).filter(Boolean)

    if (sLast.length >= 3 && pParts.some(p => p === sLast)) {
      // If ESPN name has multiple parts, verify at least first initial matches
      if (sParts.length >= 2) {
        if (pParts.some(p => p.startsWith(sFirst.charAt(0)))) return pl.id
      } else {
        return pl.id
      }
    }
    // Shirt name last-name match
    if (pl.name_on_shirt) {
      const shParts = norm(pl.name_on_shirt).replace(/[.\-]/g, ' ').split(/\s+/).filter(Boolean)
      if (sLast.length >= 3 && shParts.some(p => p === sLast)) return pl.id
    }
  }

  return null
}

// Fetch ESPN scoreboard for a date, return array of {id, home, away, status}
async function espnScoreboard(dateStr: string): Promise<Array<{id: string, home: string, away: string}>> {
  const res = await fetch(`${ESPN_API}/scoreboard?dates=${dateStr}`)
  if (!res.ok) return []
  const data = await res.json()
  return (data.events || [])
    .filter((e: any) => e.status?.type?.name === 'STATUS_FULL_TIME')
    .map((e: any) => {
      const comps = e.competitions?.[0] || {}
      const teams = comps.competitors || []
      const home = teams.find((t: any) => t.homeAway === 'home')?.team?.displayName || ''
      const away = teams.find((t: any) => t.homeAway === 'away')?.team?.displayName || ''
      return { id: e.id, home: mapEspnTeam(home), away: mapEspnTeam(away) }
    })
}

// Fetch ESPN match winner (for knockout games ending in draw after 90 min)
async function espnMatchWinner(eventId: string): Promise<string | null> {
  const res = await fetch(`${ESPN_API}/summary?event=${eventId}`)
  if (!res.ok) return null
  const data = await res.json()
  // ESPN marks the winner in competitions[0].competitors with winner:true
  const comps = data.header?.competitions?.[0] || {}
  const competitors = comps.competitors || []
  const winner = competitors.find((c: any) => c.winner === true)
  if (winner) return mapEspnTeam(winner.team?.displayName || '')
  return null
}

// ── Single ESPN fetch: extract lineups, events, and per-player data ──────────

interface MatchPlayerData {
  name: string
  short: string
  number: string
  position: string       // tactical position (e.g. "RB", "CM-L", "AM")
  espnId: string
  started: boolean
  subbedIn: boolean
  subbedOut: boolean
  formationPlace: number // 1-11 for starters, 0 for subs
  subbedInForName: string // name of player replaced (empty if N/A)
}

interface MatchEvent {
  type: 'goal' | 'assist' | 'yellow' | 'red' | 'sub_in' | 'sub_out'
  player: string
  team: string
  minute: string         // e.g. "27'", "45'+5'"
  og?: boolean           // own goal
  penaltyKick?: boolean
  replacedBy?: string    // for sub_out: who came on
  replacing?: string     // for sub_in: who went off
}

interface MatchStats {
  home: { team: string, formation: string, stats: Record<string, string | number> }
  away: { team: string, formation: string, stats: Record<string, string | number> }
}

interface EspnMatchData {
  lineups: Array<{
    team: string
    formation: string
    players: MatchPlayerData[]  // all 26 squad players
  }>
  events: MatchEvent[]
  // Legacy format for teams table (last_starting_xi / last_substitutes)
  teamLineups: Array<{
    team: string
    formation: string
    starters: Array<{ name: string, short: string, number: string, position: string }>
    substitutes: Array<{ name: string, short: string, number: string, position: string }>
  }>
  matchStats: MatchStats | null
}

async function espnMatchData(eventId: string): Promise<EspnMatchData> {
  const result: EspnMatchData = { lineups: [], events: [], teamLineups: [], matchStats: null }
  const res = await fetch(`${ESPN_API}/summary?event=${eventId}`)
  if (!res.ok) return result
  const data = await res.json()

  // ── Parse rosters ──────────────────────────────────────────────────────
  for (const r of (data.rosters || [])) {
    const team = mapEspnTeam(r.team?.displayName || '')
    const formation = r.formation || ''

    const players: MatchPlayerData[] = []
    const startersList: Array<{ name: string, short: string, number: string, position: string }> = []
    const subsList: Array<{ name: string, short: string, number: string, position: string }> = []

    for (const e of (r.roster || [])) {
      const pd: MatchPlayerData = {
        name: e.athlete?.displayName || '',
        short: e.athlete?.shortName || e.athlete?.lastName || '',
        number: e.jersey || '',
        position: e.position?.abbreviation || '',
        espnId: String(e.athlete?.id || ''),
        started: !!e.starter,
        subbedIn: !!e.subbedIn,
        subbedOut: !!e.subbedOut,
        formationPlace: parseInt(e.formationPlace) || 0,
        subbedInForName: e.subbedInFor?.athlete?.displayName || '',
      }
      players.push(pd)

      if (e.starter) {
        startersList.push({ name: pd.name, short: pd.short, number: pd.number, position: pd.position })
      }
      if (e.subbedIn) {
        subsList.push({ name: pd.name, short: pd.short, number: pd.number, position: pd.position })
      }
    }

    if (team && players.length > 0) {
      result.lineups.push({ team, formation, players })
      result.teamLineups.push({ team, formation, starters: startersList, substitutes: subsList })
    }
  }

  // ── Parse boxscore stats ─────────────────────────────────────────────
  const bsTeams = data.boxscore?.teams || []
  if (bsTeams.length >= 2) {
    const STAT_KEYS = ['possessionPct','totalShots','shotsOnTarget','wonCorners','foulsCommitted','offsides','saves','accuratePasses','totalPasses','passPct','totalCrosses','accurateCrosses']
    const extractStats = (t: any) => {
      const stats: Record<string, string | number> = {}
      for (const s of (t.statistics || [])) {
        if (STAT_KEYS.includes(s.name)) stats[s.name] = s.displayValue ?? s.value
      }
      return stats
    }
    const t0team = mapEspnTeam(bsTeams[0].team?.displayName || '')
    const t1team = mapEspnTeam(bsTeams[1].team?.displayName || '')
    const t0home = bsTeams[0].homeAway === 'home'
    const homeIdx = t0home ? 0 : 1
    const awayIdx = t0home ? 1 : 0
    const homeTeamName = t0home ? t0team : t1team
    const awayTeamName = t0home ? t1team : t0team
    const homeFmt = result.lineups.find(l => l.team === homeTeamName)?.formation || ''
    const awayFmt = result.lineups.find(l => l.team === awayTeamName)?.formation || ''
    result.matchStats = {
      home: { team: homeTeamName, formation: homeFmt, stats: extractStats(bsTeams[homeIdx]) },
      away: { team: awayTeamName, formation: awayFmt, stats: extractStats(bsTeams[awayIdx]) },
    }
  }

  // ── Parse key events (goals, cards, subs with minutes) ─────────────────
  for (const e of (data.keyEvents || [])) {
    const tt = e.type?.type || ''
    const participants = e.participants || []
    const teamName = mapEspnTeam(e.team?.displayName || '')
    const minute = e.clock?.displayValue || ''
    const athlete = participants[0]?.athlete?.displayName || ''
    if (!athlete) continue

    if (tt.includes('goal')) {
      const og = tt.includes('own-goal') || (e.text || '').includes('Own Goal')
      const pk = !!e.penaltyKick
      // For own goals, ESPN credits the benefiting team, but the scorer is on the other team.
      // Find the scorer's actual team from rosters.
      let goalTeam = teamName
      if (og) {
        // The scorer is on the opposite team
        const otherTeam = result.lineups.find(l => l.team !== teamName)
        const scorerInOther = otherTeam?.players.find(p => p.name === athlete)
        goalTeam = scorerInOther ? otherTeam!.team : teamName
      }
      result.events.push({ type: 'goal', player: athlete, team: goalTeam, minute, og, penaltyKick: pk })

      if (participants.length > 1) {
        const assistName = participants[1]?.athlete?.displayName || ''
        if (assistName) {
          result.events.push({ type: 'assist', player: assistName, team: teamName, minute })
        }
      }
    } else if (tt === 'yellow-card') {
      result.events.push({ type: 'yellow', player: athlete, team: teamName, minute })
    } else if (tt === 'red-card' || tt === 'yellow-red-card') {
      result.events.push({ type: 'red', player: athlete, team: teamName, minute })
    } else if (tt === 'substitution') {
      const subIn = participants[0]?.athlete?.displayName || ''
      const subOut = participants[1]?.athlete?.displayName || ''
      if (subIn) result.events.push({ type: 'sub_in', player: subIn, team: teamName, minute, replacing: subOut })
      if (subOut) result.events.push({ type: 'sub_out', player: subOut, team: teamName, minute, replacedBy: subIn })
    }
  }

  return result
}

// Map schedule team names → canonical names (same as shared_standings.js SCHED_TO_TEAM)
const SCHED_TO_TEAM: Record<string, string> = {
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
}

function normalizeScheduleTeam(name: string): string {
  return SCHED_TO_TEAM[name] || name
}

// Compute group standings from teams + schedule, then resolve an R32 slot label
function resolveR32Slot(
  label: string,
  teams: Array<{ name: string, group_letter: string }>,
  schedule: Array<{ home_team: string, away_team: string, home_score: number | null, away_score: number | null, status: string, group_name: string | null }>
): string | null {
  // Build standings
  const stats: Record<string, { name: string, group: string, pld: number, w: number, d: number, l: number, gf: number, ga: number, pts: number }> = {}
  teams.forEach(t => {
    stats[t.name] = { name: t.name, group: t.group_letter, pld: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }
  })

  schedule.forEach(m => {
    if (m.status !== 'FT' || !m.group_name || !m.group_name.startsWith('Group')) return
    const home = normalizeScheduleTeam(m.home_team)
    const away = normalizeScheduleTeam(m.away_team)
    const hs = m.home_score ?? 0, as = m.away_score ?? 0
    if (!stats[home] || !stats[away]) return
    stats[home].pld++; stats[away].pld++
    stats[home].gf += hs; stats[home].ga += as
    stats[away].gf += as; stats[away].ga += hs
    if (hs > as) { stats[home].w++; stats[home].pts += 3; stats[away].l++ }
    else if (hs < as) { stats[away].w++; stats[away].pts += 3; stats[home].l++ }
    else { stats[home].d++; stats[home].pts += 1; stats[away].d++; stats[away].pts += 1 }
  })

  const groups: Record<string, typeof stats[string][]> = {}
  Object.values(stats).forEach(t => {
    if (!groups[t.group]) groups[t.group] = []
    groups[t.group].push(t)
  })
  const sortTeams = (arr: typeof stats[string][]) => arr.sort((a, b) =>
    (b.pts - a.pts) || ((b.gf - b.ga) - (a.gf - a.ga)) || (b.gf - a.gf)
  )
  Object.keys(groups).forEach(g => sortTeams(groups[g]))

  // Resolve 1st/2nd
  const m1 = label.match(/^(1st|2nd)\s+([A-L])$/)
  if (m1) {
    const pos = m1[1] === '1st' ? 0 : 1
    const grp = groups[m1[2]]
    if (!grp || grp.length < 2 || grp[0].pld === 0) return null
    return grp[pos].name
  }

  // Resolve 3rd place
  const m3 = label.match(/^3rd\s+(.+)$/)
  if (m3) {
    const possibleGroups = m3[1].split('/')
    // Get all 3rd-place teams and find top 8
    const thirds: Array<typeof stats[string] & { fromGroup: string }> = []
    Object.entries(groups).forEach(([letter, t]) => {
      if (t.length >= 3) thirds.push({ ...t[2], fromGroup: letter })
    })
    thirds.sort((a, b) => (b.pts - a.pts) || ((b.gf - b.ga) - (a.gf - a.ga)) || (b.gf - a.gf))
    const qualifying = new Set(thirds.slice(0, 8).map(t => t.fromGroup))
    const matching = possibleGroups.filter(g => qualifying.has(g))
    if (matching.length === 1) return groups[matching[0]][2]?.name || null
    return null
  }

  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const log: string[] = []
  const l = (msg: string) => { log.push(msg); console.log(msg) }

  // Determine trigger source
  let trigger = 'manual'
  try {
    const body = await req.clone().json().catch(() => null)
    if (body?.trigger) trigger = body.trigger
  } catch { /* ignore */ }

  // Structured log data for sync_logs table
  const logData = {
    trigger,
    games_processed: [] as Array<{ home: string, away: string, result: string }>,
    player_stats: [] as Array<{ player: string, team: string, goals?: number, assists?: number, yellows?: number, reds?: number }>,
    unmatched: [] as string[],
    schedule_updates: 0,
    game_updates: 0,
    player_updates: 0,
    summary: '',
    ok: true,
    error: null as string | null,
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC)

    l('Starting sync...')

    // ── Load sync state ───────────────────────────────────────────────────
    const { data: stateRow } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'processed_games')
      .single()

    const processedGames: Set<string> = new Set(stateRow?.value?.game_keys || [])
    l(`Previously processed: ${processedGames.size} games`)

    // ── Step 1: Fetch games from worldcup26.ir (scores & schedule) ──────
    const res = await fetch(`${WC_API}/get/games`)
    if (!res.ok) throw new Error(`worldcup26.ir /get/games: ${res.status}`)
    const gamesData = await res.json()
    const games = Array.isArray(gamesData) ? gamesData : (gamesData.games || [])
    const finished = games.filter((g: any) => g.finished === 'TRUE')
    l(`Fetched ${games.length} games, ${finished.length} finished`)

    // ── Step 2: Update schedule table ───────────────────────────────────
    let schedUpdates = 0
    for (const g of games) {
      const homeTeam = mapWcTeam(g.home_team_name_en)
      const awayTeam = mapWcTeam(g.away_team_name_en)
      const isFt = g.finished === 'TRUE'

      const row: Record<string, any> = { status: isFt ? 'FT' : 'scheduled' }
      if (isFt) {
        row.home_score = parseInt(g.home_score)
        row.away_score = parseInt(g.away_score)
      }

      const { data: existing } = await supabase
        .from('schedule')
        .select('id,status')
        .eq('home_team', homeTeam)
        .eq('away_team', awayTeam)
        .limit(1)
        .single()

      if (existing) {
        if (existing.status !== row.status || isFt) {
          await supabase.from('schedule').update(row).eq('id', existing.id)
          schedUpdates++
        }
      }
    }
    logData.schedule_updates = schedUpdates
    l(`✓ ${schedUpdates} schedule rows updated`)

    // ── Step 3: Update games table (prediction league) ──────────────────
    const { data: predGames } = await supabase.from('games').select('id,home,away,result,round,advancer')
    let gameUpdates = 0
    if (predGames) {
      for (const pg of predGames) {
        const match = finished.find((g: any) => {
          const h = mapWcTeam(g.home_team_name_en)
          const a = mapWcTeam(g.away_team_name_en)
          return (h === pg.home || h === mapWcTeam(pg.home)) && (a === pg.away || a === mapWcTeam(pg.away))
        })
        if (!match) continue
        const result = `${match.home_score}-${match.away_score}`
        const updates: Record<string, any> = {}
        if (result !== pg.result) updates.result = result

        // For knockout draws, detect advancer from ESPN
        if (pg.round && pg.round !== 'group' && !pg.advancer) {
          const [hs, as] = [parseInt(match.home_score), parseInt(match.away_score)]
          if (hs === as) {
            // Find ESPN event to get the winner
            const dateStr = match.local_date || ''
            const dm = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
            if (dm) {
              const espnDate = `${dm[3]}${dm[1]}${dm[2]}`
              const events = await espnScoreboard(espnDate)
              const ev = events.find(e =>
                (e.home === pg.home && e.away === pg.away) ||
                (e.away === pg.home && e.home === pg.away)
              )
              if (ev) {
                const winner = await espnMatchWinner(ev.id)
                if (winner) {
                  updates.advancer = winner
                  l(`  Game ${pg.id} draw — advancer: ${winner}`)
                }
              }
            }
          }
        }

        if (Object.keys(updates).length > 0) {
          await supabase.from('games').update(updates).eq('id', pg.id)
          gameUpdates++
          logData.games_processed.push({ home: pg.home, away: pg.away, result })
          l(`  Game ${pg.id} ${pg.home} vs ${pg.away}: ${pg.result || 'null'} → ${result}`)
        }
      }
    }
    logData.game_updates = gameUpdates
    l(`✓ ${gameUpdates} game results updated`)

    // ── Step 4: Find NEW finished games ─────────────────────────────────
    const newFinished = finished.filter((g: any) => {
      const key = `${mapWcTeam(g.home_team_name_en)}|${mapWcTeam(g.away_team_name_en)}`
      return !processedGames.has(key)
    })
    l(`New finished games to process: ${newFinished.length}`)

    if (newFinished.length > 0) {
      // Load all players for matching
      let allPlayers: any[] = []
      let offset = 0
      while (true) {
        const { data } = await supabase
          .from('players')
          .select('id,name,name_on_shirt,team_name,goals,assists,yellow_cards,red_cards,matches_played,espn_id')
          .order('team_name')
          .range(offset, offset + 499)
        if (!data || data.length === 0) break
        allPlayers = allPlayers.concat(data)
        if (data.length < 500) break
        offset += 500
      }

      const playersByTeam: Record<string, typeof allPlayers> = {}
      for (const pl of allPlayers) {
        if (!playersByTeam[pl.team_name]) playersByTeam[pl.team_name] = []
        playersByTeam[pl.team_name].push(pl)
      }

      // ── Step 5: Fetch ESPN event IDs for new games ────────────────────
      const matchDates = new Set<string>()
      for (const g of newFinished) {
        const dateStr = g.local_date || ''
        const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
        if (m) matchDates.add(`${m[3]}${m[1]}${m[2]}`)
      }

      const espnEvents: Record<string, string> = {}
      for (const dateStr of matchDates) {
        const events = await espnScoreboard(dateStr)
        for (const ev of events) {
          espnEvents[`${ev.home}|${ev.away}`] = ev.id
          espnEvents[`${ev.away}|${ev.home}`] = ev.id
        }
      }
      l(`  Found ${Object.keys(espnEvents).length / 2} ESPN events for ${matchDates.size} dates`)

      // Build schedule ID lookup: canonical team names → schedule.id
      const { data: schedRows } = await supabase
        .from('schedule')
        .select('id,home_team,away_team')
        .eq('status', 'FT')
      const schedIdLookup: Record<string, number> = {}
      if (schedRows) {
        for (const s of schedRows) {
          const h = normalizeScheduleTeam(s.home_team)
          const a = normalizeScheduleTeam(s.away_team)
          schedIdLookup[`${h}|${a}`] = s.id
          schedIdLookup[`${a}|${h}`] = s.id
        }
      }

      // Aggregate stats per player across all new games
      const statDeltas: Record<number, { goals: number, assists: number, yellows: number, reds: number, name: string, team: string }> = {}
      const addStat = (pid: number, name: string, team: string, field: 'goals'|'assists'|'yellows'|'reds') => {
        if (!statDeltas[pid]) statDeltas[pid] = { goals: 0, assists: 0, yellows: 0, reds: 0, name, team }
        statDeltas[pid][field]++
      }

      // Track which players appeared (for matches_played + espn_id updates)
      const playerAppearances: Record<number, { espnId: string, espnPosition: string, count: number }> = {}

      let unmatchedPlayers: string[] = []

      for (const g of newFinished) {
        const homeTeam = mapWcTeam(g.home_team_name_en)
        const awayTeam = mapWcTeam(g.away_team_name_en)
        const gameKey = `${homeTeam}|${awayTeam}`

        const espnId = espnEvents[gameKey]
        if (!espnId) {
          l(`  ⚠ No ESPN event found for ${homeTeam} vs ${awayTeam}`)
          processedGames.add(gameKey)
          continue
        }

        // Find the schedule ID for this game
        const scheduleId = schedIdLookup[gameKey]
        if (!scheduleId) {
          l(`  ⚠ No schedule entry found for ${homeTeam} vs ${awayTeam}`)
        }

        l(`  Processing ${homeTeam} vs ${awayTeam} (ESPN ${espnId})...`)
        const matchData = await espnMatchData(espnId)

        // Update team formations/starting XI/substitutes (legacy format)
        for (const lu of matchData.teamLineups) {
          await supabase.from('teams').update({
            last_formation: lu.formation,
            last_starting_xi: lu.starters,
            last_substitutes: lu.substitutes,
          }).eq('name', lu.team)
        }

        // Write match stats to schedule table
        if (matchData.matchStats && scheduleId) {
          await supabase.from('schedule').update({ match_stats: matchData.matchStats }).eq('id', scheduleId)
        }

        // ── Build player_matches rows ─────────────────────────────────────
        // First, build per-player event data from keyEvents
        const playerEvents: Record<string, { // keyed by "team|espnPlayerName"
          goals: Array<{ minute: string, type?: string }>,
          assists: Array<{ minute: string }>,
          yellowMinute: string | null,
          redMinute: string | null,
          subInMinute: string | null,
          subOutMinute: string | null,
          replacing: string | null,
          replacedBy: string | null,
        }> = {}

        const getPlayerEvents = (team: string, name: string) => {
          const key = `${team}|${name}`
          if (!playerEvents[key]) playerEvents[key] = {
            goals: [], assists: [], yellowMinute: null, redMinute: null,
            subInMinute: null, subOutMinute: null, replacing: null, replacedBy: null,
          }
          return playerEvents[key]
        }

        for (const ev of matchData.events) {
          const pe = getPlayerEvents(ev.team, ev.player)
          if (ev.type === 'goal' && !ev.og) pe.goals.push({ minute: ev.minute })
          else if (ev.type === 'goal' && ev.og) pe.goals.push({ minute: ev.minute, type: 'own goal' })
          else if (ev.type === 'assist') pe.assists.push({ minute: ev.minute })
          else if (ev.type === 'yellow') pe.yellowMinute = ev.minute
          else if (ev.type === 'red') pe.redMinute = ev.minute
          else if (ev.type === 'sub_in') { pe.subInMinute = ev.minute; pe.replacing = ev.replacing || null }
          else if (ev.type === 'sub_out') { pe.subOutMinute = ev.minute; pe.replacedBy = ev.replacedBy || null }
        }

        // Now iterate roster players and build player_matches + stat deltas
        for (const lineup of matchData.lineups) {
          const team = lineup.team
          const teamPlayers = playersByTeam[team] || []

          for (const rp of lineup.players) {
            // Only process players who actually played (started or subbed in)
            if (!rp.started && !rp.subbedIn) continue

            const pid = matchPlayer(rp.name, team, teamPlayers)
            if (!pid) {
              if (rp.started || rp.subbedIn) unmatchedPlayers.push(`${rp.name} (${team}) [roster]`)
              continue
            }

            // Track appearances for matches_played + espn_id
            if (!playerAppearances[pid]) playerAppearances[pid] = { espnId: '', espnPosition: '', count: 0 }
            playerAppearances[pid].count++
            if (rp.espnId) playerAppearances[pid].espnId = rp.espnId
            if (rp.started && rp.position && rp.position !== 'SUB') {
              playerAppearances[pid].espnPosition = rp.position
            }

            // Get events for this player
            const pe = playerEvents[`${team}|${rp.name}`] || {
              goals: [], assists: [], yellowMinute: null, redMinute: null,
              subInMinute: null, subOutMinute: null, replacing: null, replacedBy: null,
            }

            // Resolve replaced_player_id
            let replacedPlayerId: number | null = null
            const replacingName = rp.subbedInForName || pe.replacing
            if (replacingName) {
              replacedPlayerId = matchPlayer(replacingName, team, teamPlayers)
            }

            // Insert player_matches row
            if (scheduleId) {
              const pmRow = {
                player_id: pid,
                game_id: scheduleId,
                started: rp.started,
                subbed_in: rp.subbedIn,
                subbed_out: rp.subbedOut,
                sub_minute: pe.subInMinute || pe.subOutMinute || null,
                replaced_player_id: replacedPlayerId,
                position: (rp.started && rp.position !== 'SUB') ? rp.position : null,
                goals: pe.goals.length > 0 ? JSON.stringify(pe.goals) : '[]',
                assists: pe.assists.length > 0 ? JSON.stringify(pe.assists) : '[]',
                yellow_card: pe.yellowMinute,
                red_card: pe.redMinute,
                formation_place: rp.formationPlace || null,
              }
              await supabase.from('player_matches').upsert(pmRow, { onConflict: 'player_id,game_id' })
            }

            // Aggregate stats for players table update
            for (const _goal of pe.goals) { if (!_goal.type) addStat(pid, rp.name, team, 'goals') }
            for (const _assist of pe.assists) addStat(pid, rp.name, team, 'assists')
            if (pe.yellowMinute) addStat(pid, rp.name, team, 'yellows')
            if (pe.redMinute) addStat(pid, rp.name, team, 'reds')
          }
        }

        // Also process goal/assist/card events for players not in roster (edge cases like OGs credited weirdly)
        for (const ev of matchData.events) {
          if (ev.type === 'goal' && !ev.og) {
            const teamPlayers = playersByTeam[ev.team] || []
            const pid = matchPlayer(ev.player, ev.team, teamPlayers)
            if (pid && !statDeltas[pid]) {
              // Player had a goal but wasn't matched from roster — add stat
              addStat(pid, ev.player, ev.team, 'goals')
            }
          }
        }

        const score = `${g.home_score}-${g.away_score}`
        logData.games_processed.push({ home: homeTeam, away: awayTeam, result: score })
        processedGames.add(gameKey)
      }

      // ── Step 6: Write aggregated stats + appearances to players ───────
      let playerUpdates = 0
      for (const [pidStr, delta] of Object.entries(statDeltas)) {
        const pid = Number(pidStr)
        const player = allPlayers.find(p => p.id === pid)
        if (!player) continue

        const updates: Record<string, any> = {}
        if (delta.goals > 0) updates.goals = (player.goals || 0) + delta.goals
        if (delta.assists > 0) updates.assists = (player.assists || 0) + delta.assists
        if (delta.yellows > 0) updates.yellow_cards = (player.yellow_cards || 0) + delta.yellows
        if (delta.reds > 0) updates.red_cards = (player.red_cards || 0) + delta.reds

        if (Object.keys(updates).length > 0) {
          await supabase.from('players').update(updates).eq('id', pid)
          playerUpdates++
          logData.player_stats.push({
            player: delta.name, team: delta.team,
            ...(delta.goals > 0 ? { goals: delta.goals } : {}),
            ...(delta.assists > 0 ? { assists: delta.assists } : {}),
            ...(delta.yellows > 0 ? { yellows: delta.yellows } : {}),
            ...(delta.reds > 0 ? { reds: delta.reds } : {}),
          })
        }
      }

      // Update matches_played, espn_id, espn_position for all who appeared
      for (const [pidStr, app] of Object.entries(playerAppearances)) {
        const pid = Number(pidStr)
        const player = allPlayers.find(p => p.id === pid)
        if (!player) continue

        const updates: Record<string, any> = {}
        updates.matches_played = (player.matches_played || 0) + app.count
        if (app.espnId && !player.espn_id) updates.espn_id = app.espnId
        if (app.espnPosition) updates.espn_position = app.espnPosition

        await supabase.from('players').update(updates).eq('id', pid)
      }

      logData.player_updates = playerUpdates
      logData.unmatched = unmatchedPlayers

      const totalGoals = Object.values(statDeltas).reduce((s, d) => s + d.goals, 0)
      const totalAssists = Object.values(statDeltas).reduce((s, d) => s + d.assists, 0)
      const totalYellows = Object.values(statDeltas).reduce((s, d) => s + d.yellows, 0)
      const totalReds = Object.values(statDeltas).reduce((s, d) => s + d.reds, 0)
      l(`✓ ${playerUpdates} players updated (${totalGoals}G ${totalAssists}A ${totalYellows}Y ${totalReds}R)`)
      l(`✓ ${Object.keys(playerAppearances).length} player appearances tracked`)

      if (unmatchedPlayers.length > 0) {
        l(`  Unmatched: ${unmatchedPlayers.join(', ')}`)
      }
    }

    // ── Step 7: Resolve knockout slots ──────────────────────────────────
    // Fetch all knockout prediction games and resolve placeholder team names
    const { data: koGames } = await supabase
      .from('games')
      .select('id,home,away,home_slot,away_slot,round,result,advancer')
      .neq('round', 'group')
      .order('id')

    if (koGames) {
      // Build lookup of game results for winner resolution
      const { data: allPredGames } = await supabase.from('games').select('id,home,away,result,round,advancer').order('id')
      const gameById: Record<number, any> = {}
      if (allPredGames) allPredGames.forEach(g => gameById[g.id] = g)

      // Also get group standings for R32 resolution
      const { data: teams } = await supabase.from('teams').select('name,group_letter').order('group_letter,name')
      const { data: sched } = await supabase.from('schedule').select('home_team,away_team,home_score,away_score,status,group_name').order('id')

      let slotUpdates = 0
      for (const g of koGames) {
        if (!g.home_slot) continue
        // Don't re-resolve slots for games that already have results or advancers
        if (g.result || g.advancer) continue
        let newHome = g.home, newAway = g.away

        if (g.round === 'R32' && teams && sched) {
          // Resolve from group standings
          const resolved = resolveR32Slot(g.home_slot, teams, sched)
          if (resolved && resolved !== g.home) newHome = resolved
          const resolved2 = resolveR32Slot(g.away_slot, teams, sched)
          if (resolved2 && resolved2 !== g.away) newAway = resolved2
        } else {
          // Resolve from previous round winners: W17 → winner of game 17
          const resolveWL = (slot: string) => {
            const mw = slot.match(/^W(\d+)$/)
            if (mw) {
              const prev = gameById[Number(mw[1])]
              if (!prev?.result) return null
              // If draw after 90 min, use advancer field
              const [h, a] = prev.result.split('-').map(Number)
              if (h === a) return prev.advancer || null
              return h > a ? prev.home : prev.away
            }
            const ml = slot.match(/^L(\d+)$/)
            if (ml) {
              const prev = gameById[Number(ml[1])]
              if (!prev?.result) return null
              const [h, a] = prev.result.split('-').map(Number)
              if (h === a) {
                if (!prev.advancer) return null
                return prev.advancer === prev.home ? prev.away : prev.home
              }
              return h > a ? prev.away : prev.home
            }
            return null
          }
          const rh = resolveWL(g.home_slot)
          if (rh && rh !== g.home) newHome = rh
          const ra = resolveWL(g.away_slot)
          if (ra && ra !== g.away) newAway = ra
        }

        if (newHome !== g.home || newAway !== g.away) {
          await supabase.from('games').update({ home: newHome, away: newAway }).eq('id', g.id)
          slotUpdates++
          l(`  Slot resolved: Game ${g.id} → ${newHome} vs ${newAway}`)
        }
      }
      if (slotUpdates) l(`✓ ${slotUpdates} knockout slots resolved`)
    }

    // ── Step 8: Save sync state ─────────────────────────────────────────
    await supabase.from('sync_state').upsert({
      key: 'processed_games',
      value: { game_keys: [...processedGames] },
      updated_at: new Date().toISOString(),
    })
    l(`✓ Sync state saved (${processedGames.size} games tracked)`)

    // ── Step 8: Write sync log entry ────────────────────────────────────
    logData.summary = `${logData.games_processed.length} games, ${logData.player_updates} players (${logData.schedule_updates} schedule updates)`
    await supabase.from('sync_logs').insert(logData)

    l('✓ Sync complete')
    return new Response(
      JSON.stringify({ ok: true, log }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    l(`✗ Error: ${err.message}`)

    // Log the error too
    try {
      const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
      const SUPABASE_SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const supabase = createClient(SUPABASE_URL, SUPABASE_SVC)
      logData.ok = false
      logData.error = err.message
      logData.summary = `Error: ${err.message}`
      await supabase.from('sync_logs').insert(logData)
    } catch { /* ignore logging error */ }

    return new Response(
      JSON.stringify({ ok: false, log, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
