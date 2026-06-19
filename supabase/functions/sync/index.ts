import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const API_HOST = 'https://v3.football.api-sports.io'

// Map API-Football team names to our Supabase team names
const TEAM_MAP: Record<string, string> = {
  'USA': 'USA',
  'South Korea': 'South Korea',
  'Bosnia And Herzegovina': 'Bosnia & Herz.',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Ivory Coast': "Côte d'Ivoire",
  'Cote D Ivoire': "Côte d'Ivoire",
  'Iran': 'IR Iran',
  'Cape Verde': 'Cabo Verde',
  'Cabo Verde': 'Cabo Verde',
  'DR Congo': 'DR Congo',
  'Congo DR': 'DR Congo',
  'Turkey': 'Türkiye',
  'Turkiye': 'Türkiye',
  'Czech Republic': 'Czechia',
  'Curacao': 'Curaçao',
  'Korea Republic': 'South Korea',
}

function mapTeam(name: string): string {
  return TEAM_MAP[name] || name
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

    // Read API key from Supabase Vault
    const { data: secrets, error: vaultErr } = await supabase
      .rpc('get_secret', { secret_name: 'API_FOTBALL_KEY' })

    let API_KEY = ''
    if (secrets && secrets.length > 0) {
      API_KEY = secrets[0].secret
    } else {
      // Fallback: try env var
      API_KEY = Deno.env.get('API_FOTBALL_KEY') || ''
    }
    if (!API_KEY) throw new Error('No API key found in vault (API_FOTBALL_KEY) or env')

    l('Starting sync...')

    // ── Helper: call API-Football ──────────────────────────────────────────
    async function apiFetch(endpoint: string, params: Record<string, string> = {}) {
      const url = new URL(`${API_HOST}${endpoint}`)
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
      const res = await fetch(url.toString(), {
        headers: { 'x-apisports-key': API_KEY }
      })
      if (!res.ok) throw new Error(`API ${endpoint}: ${res.status}`)
      const data = await res.json()
      if (data.errors && Object.keys(data.errors).length > 0) {
        throw new Error(`API ${endpoint}: ${JSON.stringify(data.errors)}`)
      }
      return data.response
    }

    // ── Step 1: Find FIFA World Cup 2026 league ID ────────────────────────
    let leagueId = 1 // Default FIFA World Cup ID
    try {
      const leagues = await apiFetch('/leagues', { name: 'World Cup', type: 'cup' })
      const wc = leagues.find((l: any) =>
        l.league.name.includes('World Cup') && !l.league.name.includes('Women')
        && !l.league.name.includes('Qualif') && !l.league.name.includes('U-')
        && l.country?.name === 'World'
      )
      if (wc) {
        leagueId = wc.league.id
        l(`Found league: ${wc.league.name} (ID: ${leagueId})`)
      } else {
        l(`Using default league ID: ${leagueId}`)
      }
    } catch (e: any) {
      l(`League lookup failed, using default ID ${leagueId}: ${e.message}`)
    }

    // ── Step 2: Fetch all fixtures ────────────────────────────────────────
    const fixtures = await apiFetch('/fixtures', {
      league: String(leagueId),
      season: '2026'
    })
    l(`Fetched ${fixtures.length} fixtures`)

    // ── Step 3: Upsert into schedule table ────────────────────────────────
    let schedUpdates = 0
    for (const f of fixtures) {
      const fix = f.fixture
      const teams = f.teams
      const goals = f.goals
      const stage = f.league.round || 'Group Stage'

      // Determine status
      let status = 'scheduled'
      const shortStatus = fix.status?.short || ''
      if (['FT', 'AET', 'PEN'].includes(shortStatus)) status = 'FT'
      else if (['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(shortStatus)) status = 'LIVE'
      else if (['PST', 'SUSP', 'INT'].includes(shortStatus)) status = 'postponed'
      else if (['CANC', 'ABD', 'AWD', 'WO'].includes(shortStatus)) status = 'cancelled'

      // Parse kickoff
      const kickoff = fix.date ? new Date(fix.date) : null
      const matchDate = kickoff ? kickoff.toISOString().slice(0, 10) : null
      const kickoffTime = kickoff
        ? `${String(kickoff.getUTCHours()).padStart(2,'0')}:${String(kickoff.getUTCMinutes()).padStart(2,'0')}`
        : null

      // Determine group name from round string (e.g. "Group A - 1")
      let groupName = ''
      if (stage.startsWith('Group')) {
        const gMatch = stage.match(/Group\s+([A-L])/)
        if (gMatch) groupName = `Group ${gMatch[1]}`
      }

      const homeTeam = mapTeam(teams.home.name)
      const awayTeam = mapTeam(teams.away.name)

      const row: Record<string, any> = {
        home_team: homeTeam,
        away_team: awayTeam,
        status,
        stage: stage.startsWith('Group') ? 'First Stage' : stage,
        group_name: groupName || stage,
        stadium: fix.venue?.name || '',
        city: fix.venue?.city || '',
      }
      if (matchDate) row.match_date = matchDate
      if (kickoffTime) row.kickoff_time = kickoffTime
      if (status === 'FT' || status === 'LIVE') {
        row.home_score = goals.home
        row.away_score = goals.away
      }

      // Try to match existing row by home_team + away_team
      const { data: existing } = await supabase
        .from('schedule')
        .select('id')
        .eq('home_team', homeTeam)
        .eq('away_team', awayTeam)
        .limit(1)
        .single()

      if (existing) {
        await supabase.from('schedule').update(row).eq('id', existing.id)
      } else {
        await supabase.from('schedule').insert(row)
      }
      schedUpdates++
    }
    l(`✓ ${schedUpdates} schedule rows synced`)

    // ── Step 4: Update games table results (for prediction league) ────────
    const { data: games } = await supabase.from('games').select('id,home,away,result')
    let gameUpdates = 0
    if (games) {
      for (const game of games) {
        // Find matching fixture
        const match = fixtures.find((f: any) => {
          const h = mapTeam(f.teams.home.name)
          const a = mapTeam(f.teams.away.name)
          return (h === game.home || h === mapTeam(game.home))
            && (a === game.away || a === mapTeam(game.away))
        })
        if (!match) continue
        const shortStatus = match.fixture.status?.short || ''
        if (!['FT', 'AET', 'PEN'].includes(shortStatus)) continue
        const result = `${match.goals.home}-${match.goals.away}`
        if (result !== game.result) {
          await supabase.from('games').update({ result }).eq('id', game.id)
          gameUpdates++
          l(`  Game ${game.id} ${game.home} vs ${game.away}: ${game.result || 'null'} → ${result}`)
        }
      }
    }
    l(`✓ ${gameUpdates} game results updated`)

    // ── Step 5: Fetch events for finished matches → update player stats ──
    const finishedFixtures = fixtures.filter((f: any) =>
      ['FT', 'AET', 'PEN'].includes(f.fixture.status?.short || '')
    )

    // Reset tournament stats for all players first
    await supabase.from('players').update({
      goals: 0, assists: 0, yellow_cards: 0, red_cards: 0
    }).gte('id', 0)
    l(`Reset all player stats`)

    // Aggregate events across all finished matches
    const playerStats: Record<string, { goals: number, assists: number, yellows: number, reds: number, team: string }> = {}

    for (const f of finishedFixtures) {
      const fixtureId = f.fixture.id
      try {
        const events = await apiFetch('/fixtures/events', { fixture: String(fixtureId) })
        for (const ev of events) {
          const team = mapTeam(ev.team.name)
          const playerName = ev.player?.name
          if (!playerName) continue

          const key = `${team}|${playerName.toLowerCase()}`
          if (!playerStats[key]) {
            playerStats[key] = { goals: 0, assists: 0, yellows: 0, reds: 0, team }
          }

          if (ev.type === 'Goal' && ev.detail !== 'Missed Penalty') {
            if (ev.detail === 'Own Goal') {
              // OG: don't count as a goal for the player
            } else {
              playerStats[key].goals++
            }
            // Check for assist
            if (ev.assist?.name) {
              const assistKey = `${team}|${ev.assist.name.toLowerCase()}`
              if (!playerStats[assistKey]) {
                playerStats[assistKey] = { goals: 0, assists: 0, yellows: 0, reds: 0, team }
              }
              playerStats[assistKey].assists++
            }
          } else if (ev.type === 'Card') {
            if (ev.detail === 'Yellow Card') playerStats[key].yellows++
            else if (ev.detail === 'Red Card' || ev.detail === 'Second Yellow card') playerStats[key].reds++
          }
        }
      } catch (e: any) {
        l(`  Events for fixture ${fixtureId}: ${e.message}`)
      }
    }
    l(`Parsed events for ${finishedFixtures.length} matches, ${Object.keys(playerStats).length} players`)

    // ── Step 6: Match events to players in DB and update ──────────────────
    let statUpdates = 0
    for (const [key, stats] of Object.entries(playerStats)) {
      const team = stats.team
      const playerName = key.split('|')[1]

      // Try matching by last name + team
      const nameParts = playerName.split(' ')
      const lastName = nameParts[nameParts.length - 1]

      const { data: matches } = await supabase
        .from('players')
        .select('id,name,goals,assists,yellow_cards,red_cards')
        .eq('team_name', team)
        .ilike('name', `%${lastName}%`)

      if (matches && matches.length > 0) {
        // Pick best match - prefer exact last name match
        let best = matches[0]
        if (matches.length > 1) {
          // Try to find one where first initial also matches
          const firstInitial = nameParts[0]?.[0]?.toLowerCase()
          const better = matches.find((m: any) =>
            m.name.toLowerCase().startsWith(firstInitial || '')
          )
          if (better) best = better
        }

        const updates: Record<string, number> = {}
        if (stats.goals) updates.goals = (best.goals || 0) + stats.goals
        if (stats.assists) updates.assists = (best.assists || 0) + stats.assists
        if (stats.yellows) updates.yellow_cards = (best.yellow_cards || 0) + stats.yellows
        if (stats.reds) updates.red_cards = (best.red_cards || 0) + stats.reds

        if (Object.keys(updates).length > 0) {
          await supabase.from('players').update(updates).eq('id', best.id)
          statUpdates++
        }
      }
    }
    l(`✓ ${statUpdates} player stat rows updated`)

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
