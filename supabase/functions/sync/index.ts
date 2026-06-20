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

// Fetch ESPN lineups (formation + starting XI + substitutes) for both teams
async function espnLineups(eventId: string): Promise<Array<{
  team: string, formation: string,
  starters: Array<{ name: string, short: string, number: string, position: string }>,
  substitutes: Array<{ name: string, short: string, number: string, position: string }>,
}>> {
  const result: Array<{ team: string, formation: string, starters: any[], substitutes: any[] }> = []
  const res = await fetch(`${ESPN_API}/summary?event=${eventId}`)
  if (!res.ok) return result
  const data = await res.json()
  for (const r of (data.rosters || [])) {
    const team = mapEspnTeam(r.team?.displayName || '')
    const formation = r.formation || ''
    const mapPlayer = (e: any) => ({
      name: e.athlete?.displayName || '',
      short: e.athlete?.shortName || e.athlete?.lastName || '',
      number: e.jersey || '',
      position: e.position?.abbreviation || '',
    })
    const starters = (r.roster || []).filter((e: any) => e.starter).map(mapPlayer)
    const substitutes = (r.roster || []).filter((e: any) => e.subbedIn).map(mapPlayer)
    if (team && starters.length > 0) {
      result.push({ team, formation, starters, substitutes })
    }
  }
  return result
}

// Fetch ESPN match details, return goals/assists/cards
async function espnMatchStats(eventId: string): Promise<{
  goals: Array<{ player: string, team: string, og: boolean }>,
  assists: Array<{ player: string, team: string }>,
  yellows: Array<{ player: string, team: string }>,
  reds: Array<{ player: string, team: string }>,
}> {
  const result = { goals: [] as any[], assists: [] as any[], yellows: [] as any[], reds: [] as any[] }
  const res = await fetch(`${ESPN_API}/summary?event=${eventId}`)
  if (!res.ok) return result
  const data = await res.json()

  for (const e of (data.keyEvents || [])) {
    const tt = e.type?.type || ''
    const participants = e.participants || []
    const teamName = mapEspnTeam(e.team?.displayName || '')
    const athlete = participants[0]?.athlete?.displayName || ''
    if (!athlete) continue

    if (tt.includes('goal')) {
      const og = tt.includes('own-goal') || (e.text || '').includes('Own Goal')
      result.goals.push({ player: athlete, team: og ? '' : teamName, og })

      // Assist is the second participant
      if (participants.length > 1) {
        const assistName = participants[1]?.athlete?.displayName || ''
        if (assistName) {
          result.assists.push({ player: assistName, team: teamName })
        }
      }
    } else if (tt === 'yellow-card') {
      result.yellows.push({ player: athlete, team: teamName })
    } else if (tt === 'red-card' || tt === 'yellow-red-card') {
      result.reds.push({ player: athlete, team: teamName })
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
    if (m.status !== 'FT' || !m.group_name) return
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
          .select('id,name,name_on_shirt,team_name,goals,assists,yellow_cards,red_cards')
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

      // ── Step 5: Fetch player stats from ESPN ──────────────────────────
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

      // Aggregate stats per player across all new games
      const statDeltas: Record<number, { goals: number, assists: number, yellows: number, reds: number, name: string, team: string }> = {}
      const addStat = (pid: number, name: string, team: string, field: 'goals'|'assists'|'yellows'|'reds') => {
        if (!statDeltas[pid]) statDeltas[pid] = { goals: 0, assists: 0, yellows: 0, reds: 0, name, team }
        statDeltas[pid][field]++
      }

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

        l(`  Processing ${homeTeam} vs ${awayTeam} (ESPN ${espnId})...`)
        const [stats, lineups] = await Promise.all([
          espnMatchStats(espnId),
          espnLineups(espnId),
        ])

        // Update team formations/starting XI/substitutes
        for (const lu of lineups) {
          await supabase.from('teams').update({
            last_formation: lu.formation,
            last_starting_xi: lu.starters,
            last_substitutes: lu.substitutes,
          }).eq('name', lu.team)
        }

        // Add to games_processed log
        const score = `${g.home_score}-${g.away_score}`
        logData.games_processed.push({ home: homeTeam, away: awayTeam, result: score })

        // Goals
        for (const goal of stats.goals) {
          if (goal.og) continue
          const team = goal.team
          const teamPlayers = playersByTeam[team] || []
          const pid = matchPlayer(goal.player, team, teamPlayers)
          if (pid) {
            addStat(pid, goal.player, team, 'goals')
          } else {
            unmatchedPlayers.push(`${goal.player} (${team}) [goal]`)
          }
        }

        // Assists
        for (const assist of stats.assists) {
          const teamPlayers = playersByTeam[assist.team] || []
          const pid = matchPlayer(assist.player, assist.team, teamPlayers)
          if (pid) {
            addStat(pid, assist.player, assist.team, 'assists')
          } else {
            unmatchedPlayers.push(`${assist.player} (${assist.team}) [assist]`)
          }
        }

        // Yellow cards
        for (const yc of stats.yellows) {
          const teamPlayers = playersByTeam[yc.team] || []
          const pid = matchPlayer(yc.player, yc.team, teamPlayers)
          if (pid) {
            addStat(pid, yc.player, yc.team, 'yellows')
          } else {
            unmatchedPlayers.push(`${yc.player} (${yc.team}) [yellow]`)
          }
        }

        // Red cards
        for (const rc of stats.reds) {
          const teamPlayers = playersByTeam[rc.team] || []
          const pid = matchPlayer(rc.player, rc.team, teamPlayers)
          if (pid) {
            addStat(pid, rc.player, rc.team, 'reds')
          } else {
            unmatchedPlayers.push(`${rc.player} (${rc.team}) [red]`)
          }
        }

        processedGames.add(gameKey)
      }

      // ── Step 6: Write aggregated stats to DB ──────────────────────────
      let playerUpdates = 0
      for (const [pidStr, delta] of Object.entries(statDeltas)) {
        const pid = Number(pidStr)
        const player = allPlayers.find(p => p.id === pid)
        if (!player) continue

        const updates: Record<string, number> = {}
        if (delta.goals > 0) updates.goals = (player.goals || 0) + delta.goals
        if (delta.assists > 0) updates.assists = (player.assists || 0) + delta.assists
        if (delta.yellows > 0) updates.yellow_cards = (player.yellow_cards || 0) + delta.yellows
        if (delta.reds > 0) updates.red_cards = (player.red_cards || 0) + delta.reds

        if (Object.keys(updates).length > 0) {
          await supabase.from('players').update(updates).eq('id', pid)
          playerUpdates++
          // Add to player_stats log
          logData.player_stats.push({
            player: delta.name, team: delta.team,
            ...(delta.goals > 0 ? { goals: delta.goals } : {}),
            ...(delta.assists > 0 ? { assists: delta.assists } : {}),
            ...(delta.yellows > 0 ? { yellows: delta.yellows } : {}),
            ...(delta.reds > 0 ? { reds: delta.reds } : {}),
          })
        }
      }
      logData.player_updates = playerUpdates
      logData.unmatched = unmatchedPlayers

      const totalGoals = Object.values(statDeltas).reduce((s, d) => s + d.goals, 0)
      const totalAssists = Object.values(statDeltas).reduce((s, d) => s + d.assists, 0)
      const totalYellows = Object.values(statDeltas).reduce((s, d) => s + d.yellows, 0)
      const totalReds = Object.values(statDeltas).reduce((s, d) => s + d.reds, 0)
      l(`✓ ${playerUpdates} players updated (${totalGoals}G ${totalAssists}A ${totalYellows}Y ${totalReds}R)`)

      if (unmatchedPlayers.length > 0) {
        l(`  Unmatched: ${unmatchedPlayers.join(', ')}`)
      }
    }

    // ── Step 7: Resolve knockout slots ──────────────────────────────────
    // Fetch all knockout prediction games and resolve placeholder team names
    const { data: koGames } = await supabase
      .from('games')
      .select('id,home,away,home_slot,away_slot,round,result')
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
