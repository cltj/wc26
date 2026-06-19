import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const API_HOST = 'https://v3.football.api-sports.io'
const WC_LEAGUE_ID = 1 // FIFA World Cup — hardcoded to save a request

// Map API-Football team names to our Supabase team names
const TEAM_MAP: Record<string, string> = {
  'USA': 'USA',
  'South Korea': 'South Korea',
  'Korea Republic': 'South Korea',
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
  let apiCalls = 0

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC)

    // Read API key from Supabase Vault
    const { data: secrets } = await supabase
      .rpc('get_secret', { secret_name: 'API_FOTBALL_KEY' })

    let API_KEY = ''
    if (secrets && secrets.length > 0) {
      API_KEY = secrets[0].secret
    } else {
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
      apiCalls++
      if (!res.ok) throw new Error(`API ${endpoint}: ${res.status}`)
      const data = await res.json()
      if (data.errors && Object.keys(data.errors).length > 0) {
        throw new Error(`API ${endpoint}: ${JSON.stringify(data.errors)}`)
      }
      l(`  API call #${apiCalls}: ${endpoint} (${data.results} results)`)
      return data.response
    }

    // ── Load sync state: which fixture events we've already processed ─────
    const { data: stateRow } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'processed_fixtures')
      .single()

    const processedFixtures: Set<number> = new Set(
      stateRow?.value?.fixture_ids || []
    )
    l(`Previously processed events for ${processedFixtures.size} fixtures`)

    // ── Step 1: Fetch all fixtures (1 API call) ───────────────────────────
    const fixtures = await apiFetch('/fixtures', {
      league: String(WC_LEAGUE_ID),
      season: '2026'
    })
    l(`Fetched ${fixtures.length} fixtures`)

    // ── Step 2: Upsert into schedule table ────────────────────────────────
    let schedUpdates = 0
    for (const f of fixtures) {
      const fix = f.fixture
      const teams = f.teams
      const goals = f.goals
      const stage = f.league.round || 'Group Stage'

      let status = 'scheduled'
      const shortStatus = fix.status?.short || ''
      if (['FT', 'AET', 'PEN'].includes(shortStatus)) status = 'FT'
      else if (['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(shortStatus)) status = 'LIVE'
      else if (['PST', 'SUSP', 'INT'].includes(shortStatus)) status = 'postponed'
      else if (['CANC', 'ABD', 'AWD', 'WO'].includes(shortStatus)) status = 'cancelled'

      const kickoff = fix.date ? new Date(fix.date) : null
      const matchDate = kickoff ? kickoff.toISOString().slice(0, 10) : null
      const kickoffTime = kickoff
        ? `${String(kickoff.getUTCHours()).padStart(2, '0')}:${String(kickoff.getUTCMinutes()).padStart(2, '0')}`
        : null

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

    // ── Step 3: Update games table results (for prediction league) ────────
    const { data: games } = await supabase.from('games').select('id,home,away,result')
    let gameUpdates = 0
    if (games) {
      for (const game of games) {
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

    // ── Step 4: Fetch events ONLY for newly finished matches ──────────────
    const finishedFixtures = fixtures.filter((f: any) =>
      ['FT', 'AET', 'PEN'].includes(f.fixture.status?.short || '')
    )
    const newlyFinished = finishedFixtures.filter((f: any) =>
      !processedFixtures.has(f.fixture.id)
    )
    l(`Finished: ${finishedFixtures.length} total, ${newlyFinished.length} new to process`)

    // Budget check: we've used 1 call for fixtures.
    // Each event fetch = 1 call. Cap at 14 per sync (6 syncs/day × 15 = 90 < 100).
    const MAX_EVENT_CALLS = 14
    const toProcess = newlyFinished.slice(0, MAX_EVENT_CALLS)
    if (newlyFinished.length > MAX_EVENT_CALLS) {
      l(`  Rate limited: processing ${MAX_EVENT_CALLS} of ${newlyFinished.length} new matches`)
    }

    // Collect all events from newly finished matches
    const playerStats: Record<string, {
      goals: number, assists: number, yellows: number, reds: number, team: string, name: string
    }> = {}

    for (const f of toProcess) {
      const fixtureId = f.fixture.id
      const homeTeam = mapTeam(f.teams.home.name)
      const awayTeam = mapTeam(f.teams.away.name)
      try {
        const events = await apiFetch('/fixtures/events', { fixture: String(fixtureId) })
        for (const ev of events) {
          const team = mapTeam(ev.team.name)
          const playerName = ev.player?.name
          if (!playerName) continue

          const key = `${team}|${playerName.toLowerCase()}`
          if (!playerStats[key]) {
            playerStats[key] = { goals: 0, assists: 0, yellows: 0, reds: 0, team, name: playerName }
          }

          if (ev.type === 'Goal' && ev.detail !== 'Missed Penalty') {
            if (ev.detail !== 'Own Goal') {
              playerStats[key].goals++
            }
            if (ev.assist?.name) {
              const assistKey = `${team}|${ev.assist.name.toLowerCase()}`
              if (!playerStats[assistKey]) {
                playerStats[assistKey] = { goals: 0, assists: 0, yellows: 0, reds: 0, team, name: ev.assist.name }
              }
              playerStats[assistKey].assists++
            }
          } else if (ev.type === 'Card') {
            if (ev.detail === 'Yellow Card') playerStats[key].yellows++
            else if (ev.detail === 'Red Card' || ev.detail === 'Second Yellow card') playerStats[key].reds++
          }
        }
        processedFixtures.add(fixtureId)
        l(`  Fixture ${fixtureId} (${homeTeam} vs ${awayTeam}): ${events.length} events`)
      } catch (e: any) {
        l(`  Fixture ${fixtureId} events failed: ${e.message}`)
      }
    }

    // ── Step 5: Apply incremental stat updates to players table ───────────
    let statUpdates = 0
    for (const [key, stats] of Object.entries(playerStats)) {
      const team = stats.team
      const nameParts = stats.name.split(' ')
      const lastName = nameParts[nameParts.length - 1]

      // Find matching player(s) by team + last name
      const { data: matches } = await supabase
        .from('players')
        .select('id,name,goals,assists,yellow_cards,red_cards')
        .eq('team_name', team)
        .ilike('name', `%${lastName}%`)

      if (matches && matches.length > 0) {
        // Pick best match
        let best = matches[0]
        if (matches.length > 1) {
          const firstInitial = nameParts[0]?.[0]?.toLowerCase()
          const better = matches.find((m: any) =>
            m.name.toLowerCase().startsWith(firstInitial || '')
          )
          if (better) best = better
        }

        // Increment stats (don't reset — we only process new matches)
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

    // ── Step 6: Save sync state ───────────────────────────────────────────
    const stateValue = { fixture_ids: [...processedFixtures] }
    await supabase.from('sync_state').upsert({
      key: 'processed_fixtures',
      value: stateValue,
      updated_at: new Date().toISOString(),
    })
    l(`✓ Sync state saved (${processedFixtures.size} fixtures tracked)`)

    l(`✓ Sync complete — ${apiCalls} API calls used`)
    return new Response(
      JSON.stringify({ ok: true, log, api_calls: apiCalls }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    l(`✗ Error: ${err.message}`)
    return new Response(
      JSON.stringify({ ok: false, log, error: err.message, api_calls: apiCalls }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
