import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const WC_API = 'https://worldcup26.ir'

// Map worldcup26.ir team names → Supabase team names
const TEAM_MAP: Record<string, string> = {
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

function mapTeam(name: string): string {
  return TEAM_MAP[name] || name
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

// Garbled matchday-2 scorer names → correct Supabase names
const SCORER_FIXES: Record<string, string> = {
  'jvhan mnzambi|Switzerland': 'Johan Manzambi',
  'rvbn vargas|Switzerland': 'Ruben Vargas',
  'armin mhmich|Bosnia & Herz.': 'Armin Mahmic',
  'kail larin|Canada': 'Cyle Larin',
  'rvmanv ashmid|Austria': 'Romano Schmid',
  'mikhal sadilk|Czechia': 'Michal Sadilek',
  'dnil mvnvz|Colombia': 'Daniel Munoz',
  'lviiz diaz|Colombia': 'Luis Diaz',
  'khamintvn kampaz|Colombia': 'Jhaminton Campaz',
  'kalb iirnki|Ghana': 'Caleb Yirenkyi',
  'abas bk fiz allh af|Uzbekistan': 'Abbosbek Fayzullaev',
  'izn alarb|Austria': 'David Alaba',
  'ali avlvan|Jordan': 'Ali Olwan',
  'y.ayari|Sweden': 'Yacine Ayari',
  'ramin rezaiian|IR Iran': 'Ramin Rezaeian',
  'leo ostigard|Norway': 'Leo Ostigard',
  'abdulelah al-amri|Saudi Arabia': 'Abdulelah Ali A Alamri',
}

// Parse scorer strings from a single game
function parseScorers(game: any): Array<{ team: string, name: string, og: boolean }> {
  const result: Array<{ team: string, name: string, og: boolean }> = []
  for (const [side, teamKey] of [['home_scorers', 'home_team_name_en'], ['away_scorers', 'away_team_name_en']] as const) {
    const raw = game[side]
    if (!raw || raw === 'null') continue
    const matches = raw.match(/[\u201c\u201d"""]([^"\u201c\u201d"""]+)[\u201c\u201d"""]/g) || []
    const apiTeam = game[teamKey]
    const apiOpp = teamKey === 'home_team_name_en' ? game.away_team_name_en : game.home_team_name_en

    for (let s of matches) {
      s = s.replace(/^[\u201c\u201d"""]|[\u201c\u201d"""]$/g, '')
      const og = s.includes('(OG)')
      const team = mapTeam(og ? apiOpp : apiTeam)
      let name = s.replace(/\s*\d+[\u2019'`+].*$/, '').replace(/[\u202b\u200f\u200e]/g, '').trim()

      const fixKey = norm(name) + '|' + team
      if (SCORER_FIXES[fixKey]) name = SCORER_FIXES[fixKey]

      result.push({ team, name, og })
    }
  }
  return result
}

// Match a scorer name to a Supabase player
function matchPlayer(
  scorerName: string, team: string,
  teamPlayers: Array<{ id: number, name: string, name_on_shirt: string | null }>
): number | null {
  const sNorm = norm(scorerName)
  const sParts = sNorm.replace(/[.]/g, '').split(/\s+/).filter(Boolean)
  const sLast = sParts[sParts.length - 1] || ''

  for (const pl of teamPlayers) {
    const pNorm = norm(pl.name)
    const pParts = pNorm.replace(/[.\-]/g, ' ').split(/\s+/).filter(Boolean)

    // Last name match
    if (sLast.length >= 2 && pParts.some(p => p === sLast)) return pl.id
    // Full containment
    if (pNorm.includes(sNorm) || sNorm.includes(pNorm)) return pl.id
    // All significant parts match
    if (sParts.length >= 2) {
      const long = sParts.filter(p => p.length > 1)
      if (long.length > 0 && long.every(p => pParts.some(pp => pp === p || pp.startsWith(p)))) return pl.id
    }
    // Try shirt name
    if (pl.name_on_shirt) {
      const shNorm = norm(pl.name_on_shirt)
      const shParts = shNorm.replace(/[.\-]/g, ' ').split(/\s+/).filter(Boolean)
      if (sLast.length >= 2 && shParts.some(p => p === sLast)) return pl.id
      if (shNorm.includes(sNorm) || sNorm.includes(shNorm)) return pl.id
    }
  }
  return null
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

    // Set of "home_team|away_team" keys for games we've already processed events for
    const processedGames: Set<string> = new Set(stateRow?.value?.game_keys || [])
    l(`Previously processed: ${processedGames.size} games`)

    // ── Step 1: Fetch games from worldcup26.ir ────────────────────────────
    const res = await fetch(`${WC_API}/get/games`)
    if (!res.ok) throw new Error(`worldcup26.ir /get/games: ${res.status}`)
    const gamesData = await res.json()
    const games = Array.isArray(gamesData) ? gamesData : (gamesData.games || [])
    const finished = games.filter((g: any) => g.finished === 'TRUE')
    l(`Fetched ${games.length} games, ${finished.length} finished`)

    // ── Step 2: Update schedule table ─────────────────────────────────────
    let schedUpdates = 0
    for (const g of games) {
      const homeTeam = mapTeam(g.home_team_name_en)
      const awayTeam = mapTeam(g.away_team_name_en)
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
        // Only update if status changed or scores differ
        if (existing.status !== row.status || isFt) {
          await supabase.from('schedule').update(row).eq('id', existing.id)
          schedUpdates++
        }
      }
    }
    l(`✓ ${schedUpdates} schedule rows updated`)

    // ── Step 3: Update games table (prediction league) ────────────────────
    const { data: predGames } = await supabase.from('games').select('id,home,away,result')
    let gameUpdates = 0
    if (predGames) {
      for (const pg of predGames) {
        const match = finished.find((g: any) => {
          const h = mapTeam(g.home_team_name_en)
          const a = mapTeam(g.away_team_name_en)
          return (h === pg.home || h === mapTeam(pg.home)) && (a === pg.away || a === mapTeam(pg.away))
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

    // ── Step 4: Process scorer data for NEW finished games only ───────────
    const newFinished = finished.filter((g: any) => {
      const key = `${mapTeam(g.home_team_name_en)}|${mapTeam(g.away_team_name_en)}`
      return !processedGames.has(key)
    })
    l(`New finished games to process: ${newFinished.length}`)

    if (newFinished.length > 0) {
      // Load all players for matching (only need id, name, shirt, team)
      let allPlayers: any[] = []
      let offset = 0
      while (true) {
        const { data } = await supabase
          .from('players')
          .select('id,name,name_on_shirt,team_name,goals')
          .order('team_name')
          .range(offset, offset + 499)
        if (!data || data.length === 0) break
        allPlayers = allPlayers.concat(data)
        if (data.length < 500) break
        offset += 500
      }

      // Index players by team
      const playersByTeam: Record<string, typeof allPlayers> = {}
      for (const pl of allPlayers) {
        if (!playersByTeam[pl.team_name]) playersByTeam[pl.team_name] = []
        playersByTeam[pl.team_name].push(pl)
      }

      let goalUpdates = 0
      let unmatched: string[] = []

      // Aggregate goals per player across all new games first
      const goalCounts: Record<number, number> = {}

      for (const g of newFinished) {
        const homeTeam = mapTeam(g.home_team_name_en)
        const awayTeam = mapTeam(g.away_team_name_en)
        const scorers = parseScorers(g)

        for (const s of scorers) {
          const teamPlayers = playersByTeam[s.team] || []
          const playerId = matchPlayer(s.name, s.team, teamPlayers)

          if (playerId) {
            if (!s.og) {
              goalCounts[playerId] = (goalCounts[playerId] || 0) + 1
            }
          } else {
            unmatched.push(`${s.name} (${s.team})`)
          }
        }

        processedGames.add(`${homeTeam}|${awayTeam}`)
      }

      // Now write aggregated goals to DB in one pass
      for (const [playerId, addGoals] of Object.entries(goalCounts)) {
        const player = allPlayers.find(p => p.id === Number(playerId))
        const newGoals = (player?.goals || 0) + addGoals
        await supabase.from('players').update({ goals: newGoals }).eq('id', Number(playerId))
        goalUpdates++
      }

      l(`✓ ${goalUpdates} player goals incremented`)
      if (unmatched.length > 0) {
        l(`  Unmatched scorers: ${unmatched.join(', ')}`)
      }
    }

    // ── Step 5: Use Claude web search for cards/assists on new games ──────
    if (newFinished.length > 0) {
      const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_KEY') || ''
      if (ANTHROPIC_KEY) {
        try {
          // Build a focused prompt for just the new matches
          const matchList = newFinished.map((g: any) =>
            `${mapTeam(g.home_team_name_en)} ${g.home_score}-${g.away_score} ${mapTeam(g.away_team_name_en)}`
          ).join('\n')

          const prompt = `For these FIFA World Cup 2026 matches that just finished:\n${matchList}\n\nSearch the web and return a JSON array of players who received yellow cards, red cards, or made assists in these specific matches. Return ONLY valid JSON, no markdown:\n[{"name":"Player Name","team":"Team Name","yellow_cards":1,"red_cards":0,"assists":0}]\nOnly include players with at least one card or assist. Use official team names.`

          l('Calling Claude for cards/assists...')
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 4000,
              system: 'You are a data assistant. Respond with ONLY valid JSON, no prose or markdown fences.',
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{ role: 'user', content: prompt }]
            })
          })

          if (aiRes.ok) {
            const aiData = await aiRes.json()
            const text = aiData.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || ''
            const jsonMatch = text.match(/\[[\s\S]*\]/)
            if (jsonMatch) {
              const cardData = JSON.parse(jsonMatch[0])
              let cardUpdates = 0

              // Load all players for matching
              let allPlayers: any[] = []
              let offset = 0
              while (true) {
                const { data } = await supabase
                  .from('players')
                  .select('id,name,name_on_shirt,team_name,assists,yellow_cards,red_cards')
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

              for (const entry of cardData) {
                const team = mapTeam(entry.team)
                const teamPlayers = playersByTeam[team] || []
                const playerId = matchPlayer(entry.name, team, teamPlayers)
                if (!playerId) continue

                const player = allPlayers.find(p => p.id === playerId)
                if (!player) continue

                const updates: Record<string, number> = {}
                if (entry.assists) updates.assists = (player.assists || 0) + entry.assists
                if (entry.yellow_cards) updates.yellow_cards = (player.yellow_cards || 0) + entry.yellow_cards
                if (entry.red_cards) updates.red_cards = (player.red_cards || 0) + entry.red_cards

                if (Object.keys(updates).length > 0) {
                  await supabase.from('players').update(updates).eq('id', playerId)
                  cardUpdates++
                }
              }
              l(`✓ ${cardUpdates} player card/assist updates from Claude`)
            }
          }
        } catch (e: any) {
          l(`Claude cards/assists failed (non-fatal): ${e.message}`)
        }
      } else {
        l('No ANTHROPIC_KEY — skipping cards/assists lookup')
      }
    }

    // ── Step 6: Save sync state ───────────────────────────────────────────
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
