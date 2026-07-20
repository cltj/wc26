import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_HEADSHOT = "https://a.espncdn.com/i/headshots/soccer/players/full";
const BATCH_SIZE = 30; // clubs per invocation
const FRESHNESS_HOURS = 24;

// ESPN citizenship → our national_teams.name
const NATIONALITY_MAP: Record<string, string> = {
  "United States": "USA",
  "Ivory Coast": "Côte d'Ivoire",
  "Turkey": "Türkiye",
  "Iran": "IR Iran",
  "Czech Republic": "Czechia",
  "Bosnia and Herzegovina": "Bosnia & Herz.",
  "Cape Verde": "Cabo Verde",
  "Republic of Ireland": "Ireland",
  "Korea Republic": "South Korea",
  "Congo DR": "DR Congo",
  "Democratic Republic of the Congo": "DR Congo",
  "Cote d'Ivoire": "Côte d'Ivoire",
  "Curacao": "Curaçao",
  "China PR": "China",
  "Trinidad and Tobago": "Trinidad & Tobago",
  "St Kitts and Nevis": "St. Kitts & Nevis",
  "Antigua and Barbuda": "Antigua & Barbuda",
  "Bosnia-Herzegovina": "Bosnia & Herz.",
};

function inchesToCm(inches: number | null): number | null {
  return inches ? Math.round(inches * 2.54) : null;
}

function lbsToKg(lbs: number | null): number | null {
  return lbs ? Math.round(lbs * 0.453592) : null;
}

function positionAbbr(pos: any): string | null {
  if (!pos) return null;
  const map: Record<string, string> = { G: "GK", D: "DF", M: "MF", F: "FW" };
  return map[pos.abbreviation] || pos.abbreviation || null;
}

async function espnFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 10000));
      const retry = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!retry.ok) throw new Error(`ESPN ${retry.status}`);
      return retry.json();
    }
    throw new Error(`ESPN ${res.status}`);
  }
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const log: string[] = [];
  const now = new Date().toISOString();

  try {
    // Parse optional params
    let body: any = {};
    try { body = await req.json(); } catch {}
    const limit = body.limit || BATCH_SIZE;
    const league = body.league || null;
    const freshness = body.freshness || FRESHNESS_HOURS;

    // Load national teams for nationality mapping
    const { data: natTeams } = await supabase
      .from("national_teams")
      .select("id,name");
    const natByName: Record<string, number> = {};
    (natTeams || []).forEach((t: any) => { natByName[t.name] = t.id; });

    // Find stale clubs
    const cutoff = new Date(Date.now() - freshness * 3600000).toISOString();
    let query = supabase
      .from("club_teams")
      .select("id,espn_team_id,name,league_espn_code,roster_updated_at")
      .or(`roster_updated_at.is.null,roster_updated_at.lt.${cutoff}`)
      .order("roster_updated_at", { ascending: true, nullsFirst: true })
      .limit(limit);

    if (league) {
      query = query.eq("league_espn_code", league.toUpperCase());
    }

    const { data: clubs } = await query;
    if (!clubs || clubs.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "All clubs are fresh", clubs: 0, players: 0, log: ["All clubs up to date"] }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    log.push(`Processing ${clubs.length} stale clubs...`);

    let totalPlayers = 0;
    let errors = 0;
    let empty = 0;

    for (const club of clubs) {
      try {
        const url = `${ESPN_BASE}/${club.league_espn_code.toLowerCase()}/teams/${club.espn_team_id}/roster`;
        const data = await espnFetch(url);
        const athletes = data.athletes || [];

        if (!athletes.length) {
          empty++;
          await supabase
            .from("club_teams")
            .update({ roster_updated_at: now })
            .eq("id", club.id);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        const playerRows = athletes
          .filter((a: any) => a.id)
          .map((a: any) => {
            const citizenship = a.citizenship || "";
            const mapped = NATIONALITY_MAP[citizenship] || citizenship;
            let natId = natByName[mapped] || null;
            // Fuzzy fallback
            if (!natId && citizenship) {
              for (const [name, id] of Object.entries(natByName)) {
                if (
                  citizenship.toLowerCase().includes(name.toLowerCase()) ||
                  name.toLowerCase().includes(citizenship.toLowerCase())
                ) {
                  natId = id;
                  break;
                }
              }
            }

            return {
              espn_id: parseInt(a.id),
              name: a.fullName || a.displayName || "",
              first_name: a.firstName || "",
              last_name: a.lastName || "",
              short_name: a.shortName || "",
              date_of_birth: a.dateOfBirth ? a.dateOfBirth.substring(0, 10) : null,
              nationality_id: natId,
              primary_position: positionAbbr(a.position),
              height_cm: inchesToCm(a.height),
              weight_kg: lbsToKg(a.weight),
              current_club_id: club.id,
              image_url: `${ESPN_HEADSHOT}/${a.id}.png`,
              updated_at: now,
            };
          });

        if (playerRows.length) {
          const { error } = await supabase
            .from("players")
            .upsert(playerRows, { onConflict: "espn_id" });
          if (error) throw new Error(error.message);
          totalPlayers += playerRows.length;
        }

        await supabase
          .from("club_teams")
          .update({ roster_updated_at: now })
          .eq("id", club.id);

        log.push(`✓ ${club.name}: ${playerRows.length} players`);
        await new Promise((r) => setTimeout(r, 1000));
      } catch (e: any) {
        errors++;
        log.push(`✗ ${club.name}: ${e.message}`);
      }
    }

    const summary = `${clubs.length} clubs, ${totalPlayers} players, ${errors} errors, ${empty} empty`;
    log.push(`Done: ${summary}`);

    return new Response(
      JSON.stringify({ ok: true, clubs: clubs.length, players: totalPlayers, errors, empty, log }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    log.push(`✗ Fatal: ${e.message}`);
    return new Response(
      JSON.stringify({ ok: false, error: e.message, log }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
