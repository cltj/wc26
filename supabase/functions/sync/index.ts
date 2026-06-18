import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const log: string[] = []
  const l = (msg: string) => { log.push(msg); console.log(msg) }

  try {
    const ANTHROPIC_KEY   = Deno.env.get('ANTHROPIC_KEY')!
    const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SVC    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC)

    // ── Step 1: Ask Claude to fetch latest WC data ──────────────────────────
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

    const prompt = `Today is ${today}. Search the web and return current FIFA World Cup 2026 data as a single JSON object.

Return ONLY valid JSON, no markdown, no explanation. Use this exact structure:

{
  "games": [
    {"id": 1, "result": "2-0"},
    {"id": 2, "result": "1-1"}
  ],
  "groups": {
    "A": [
      {"name": "Mexico", "pld": 2, "w": 2, "d": 0, "l": 0, "gf": 4, "ga": 1, "pts": 6}
    ]
  },
  "scorers": [
    {"name": "Erling Haaland", "team": "Norway", "goals": 3, "assists": 1}
  ],
  "bookings": [
    {"name": "Player Name", "team": "Team Name", "yellow_cards": 2, "red_cards": 0}
  ]
}

Only include games with a known result. Include all 12 groups A-L with all 4 teams each sorted by pts desc then GD desc.
For "scorers": include EVERY player who has scored or assisted in the tournament so far, not just the top ones. Include own goals credited to the correct team's tally. This is critical — the total goals across all scorers must match the total GF across all groups.
For "bookings": include EVERY player who has received a yellow or red card.
Game IDs: 1=Mexico vs South Africa, 2=Canada vs Bosnia, 3=Brazil vs Morocco, 4=Netherlands vs Japan, 5=Belgium vs Egypt, 6=Iraq vs Norway, 7=England vs Croatia, 8=Mexico vs Korea, 9=USA vs Australia, 10=Germany vs Cote d'Ivoire, 11=Spain vs Saudi Arabia, 12=Norway vs Senegal, 13=England vs Ghana, 14=Scotland vs Brazil, 15=Ecuador vs Germany, 16=Norway vs France.`

    l('Calling Anthropic API with web search…')
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: 'You are a data-fetching assistant. Always respond with ONLY valid JSON, no prose, no markdown fences.',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!aiRes.ok) throw new Error(`Anthropic error: ${aiRes.status} ${await aiRes.text()}`)
    const aiData = await aiRes.json()
    const text = aiData.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    // Extract JSON object from response even if surrounded by prose
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')
    const parsed = JSON.parse(jsonMatch[0])
    l(`✓ Data fetched`)

    // ── Step 2: Update game results ─────────────────────────────────────────
    let gameUpdates = 0
    for (const g of (parsed.games || [])) {
      if (!g.result) continue
      const { error } = await supabase.from('games').update({ result: g.result }).eq('id', g.id)
      if (!error) gameUpdates++
    }
    l(`✓ ${gameUpdates} game results updated`)

    // ── Step 3: Update player stats ─────────────────────────────────────────
    let playerUpdates = 0
    const playerMap: Record<string, any> = {}

    for (const p of (parsed.scorers || [])) {
      const key = p.name.toLowerCase()
      playerMap[key] = { ...playerMap[key], name: p.name, team: p.team, goals: p.goals || 0, assists: p.assists || 0 }
    }
    for (const p of (parsed.bookings || [])) {
      const key = p.name.toLowerCase()
      playerMap[key] = { ...playerMap[key], name: p.name, team: p.team, yellow_cards: p.yellow_cards || 0, red_cards: p.red_cards || 0 }
    }

    for (const p of Object.values(playerMap)) {
      const updates: any = {}
      if (p.goals        !== undefined) updates.goals        = p.goals
      if (p.assists      !== undefined) updates.assists      = p.assists
      if (p.yellow_cards !== undefined) updates.yellow_cards = p.yellow_cards
      if (p.red_cards    !== undefined) updates.red_cards    = p.red_cards
      if (!Object.keys(updates).length) continue

      // Match on last name + team for reliability
      const lastName = p.name.split(' ').pop()
      let query = supabase.from('players').update(updates).ilike('name', `%${lastName}%`)
      if (p.team) query = query.eq('team_name', p.team)
      const { error } = await query
      if (!error) playerUpdates++
    }
    l(`✓ ${playerUpdates} player stat rows updated`)

    // ── Step 4: Return group standings to frontend for live render ───────────
    l('✓ Sync complete')

    return new Response(
      JSON.stringify({ ok: true, log, groups: parsed.groups }),
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
