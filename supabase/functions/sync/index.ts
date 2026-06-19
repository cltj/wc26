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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const log: string[] = []
  const l = (msg: string) => { log.push(msg); console.log(msg) }

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
    l(`✓ ${schedUpdates} schedule rows updated`)

    // ── Step 3: Update games table (prediction league) ──────────────────
    const { data: predGames } = await supabase.from('games').select('id,home,away,result')
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
        if (result !== pg.result) {
          await supabase.from('games').update({ result }).eq('id', pg.id)
          gameUpdates++
          l(`  Game ${pg.id} ${pg.home} vs ${pg.away}: ${pg.result || 'null'} → ${result}`)
        }
      }
    }
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
      // Collect unique match dates from new games to query ESPN scoreboard
      const matchDates = new Set<string>()
      for (const g of newFinished) {
        // worldcup26.ir date format: "MM/DD/YYYY HH:mm" or similar
        const dateStr = g.local_date || ''
        const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
        if (m) matchDates.add(`${m[3]}${m[1]}${m[2]}`) // YYYYMMDD
      }

      // Build ESPN event lookup: sbTeamKey → espnEventId
      const espnEvents: Record<string, string> = {}
      for (const dateStr of matchDates) {
        const events = await espnScoreboard(dateStr)
        for (const ev of events) {
          espnEvents[`${ev.home}|${ev.away}`] = ev.id
          // Also store reverse in case ESPN swaps home/away
          espnEvents[`${ev.away}|${ev.home}`] = ev.id
        }
      }
      l(`  Found ${Object.keys(espnEvents).length / 2} ESPN events for ${matchDates.size} dates`)

      // Aggregate stats per player across all new games
      const statDeltas: Record<number, { goals: number, assists: number, yellows: number, reds: number, name: string }> = {}
      const addStat = (pid: number, name: string, field: 'goals'|'assists'|'yellows'|'reds') => {
        if (!statDeltas[pid]) statDeltas[pid] = { goals: 0, assists: 0, yellows: 0, reds: 0, name }
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
        const stats = await espnMatchStats(espnId)

        // Goals
        for (const goal of stats.goals) {
          if (goal.og) continue // own goals don't count for the scorer
          const team = goal.team
          const teamPlayers = playersByTeam[team] || []
          const pid = matchPlayer(goal.player, team, teamPlayers)
          if (pid) {
            addStat(pid, goal.player, 'goals')
          } else {
            unmatchedPlayers.push(`${goal.player} (${team}) [goal]`)
          }
        }

        // Assists
        for (const assist of stats.assists) {
          const teamPlayers = playersByTeam[assist.team] || []
          const pid = matchPlayer(assist.player, assist.team, teamPlayers)
          if (pid) {
            addStat(pid, assist.player, 'assists')
          } else {
            unmatchedPlayers.push(`${assist.player} (${assist.team}) [assist]`)
          }
        }

        // Yellow cards
        for (const yc of stats.yellows) {
          const teamPlayers = playersByTeam[yc.team] || []
          const pid = matchPlayer(yc.player, yc.team, teamPlayers)
          if (pid) {
            addStat(pid, yc.player, 'yellows')
          } else {
            unmatchedPlayers.push(`${yc.player} (${yc.team}) [yellow]`)
          }
        }

        // Red cards
        for (const rc of stats.reds) {
          const teamPlayers = playersByTeam[rc.team] || []
          const pid = matchPlayer(rc.player, rc.team, teamPlayers)
          if (pid) {
            addStat(pid, rc.player, 'reds')
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
        }
      }

      const totalGoals = Object.values(statDeltas).reduce((s, d) => s + d.goals, 0)
      const totalAssists = Object.values(statDeltas).reduce((s, d) => s + d.assists, 0)
      const totalYellows = Object.values(statDeltas).reduce((s, d) => s + d.yellows, 0)
      const totalReds = Object.values(statDeltas).reduce((s, d) => s + d.reds, 0)
      l(`✓ ${playerUpdates} players updated (${totalGoals}G ${totalAssists}A ${totalYellows}Y ${totalReds}R)`)

      if (unmatchedPlayers.length > 0) {
        l(`  Unmatched: ${unmatchedPlayers.join(', ')}`)
      }
    }

    // ── Step 7: Save sync state ─────────────────────────────────────────
    await supabase.from('sync_state').upsert({
      key: 'processed_games',
      value: { game_keys: [...processedGames] },
      updated_at: new Date().toISOString(),
    })
    l(`✓ Sync state saved (${processedGames.size} games tracked)`)

    l('✓ Sync complete')
    return new Response(
      JSON.stringify({ ok: true, log }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    l(`✗ Error: ${err.message}`)
    return new Response(
      JSON.stringify({ ok: false, log, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
