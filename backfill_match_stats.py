#!/usr/bin/env python3
"""Backfill match_stats for all finished schedule games from ESPN API."""

import json
import time
import urllib.request

SB_URL = "https://hsanauyxexbyefmefhcd.supabase.co"
SB_SVC_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4"
ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"

SB_HEADERS = {
    "apikey": SB_SVC_KEY,
    "Authorization": f"Bearer {SB_SVC_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

ESPN_TEAM_MAP = {
    "United States": "USA", "Turkey": "Türkiye", "Türkiye": "Türkiye",
    "Czechia": "Czechia", "Czech Republic": "Czechia",
    "Bosnia-Herzegovina": "Bosnia & Herz.",
    "Ivory Coast": "Côte d'Ivoire", "Côte d'Ivoire": "Côte d'Ivoire",
    "Iran": "IR Iran", "IR Iran": "IR Iran",
    "Cape Verde": "Cabo Verde", "Cabo Verde": "Cabo Verde",
    "Congo DR": "DR Congo", "DR Congo": "DR Congo",
    "South Korea": "South Korea", "Korea Republic": "South Korea",
    "Curaçao": "Curaçao", "Curacao": "Curaçao",
}

SCHED_TEAM_MAP = {
    "Korea Republic": "South Korea", "Bosnia and Herzegovina": "Bosnia & Herz.",
    "Ivory Coast": "Côte d'Ivoire", "Iran": "IR Iran", "Cape Verde": "Cabo Verde",
    "Democratic Republic of the Congo": "DR Congo", "United States": "USA",
    "Turkey": "Türkiye", "Czech Republic": "Czechia",
}

STAT_KEYS = [
    "possessionPct", "totalShots", "shotsOnTarget", "wonCorners",
    "foulsCommitted", "offsides", "saves", "accuratePasses",
    "totalPasses", "passPct", "totalCrosses", "accurateCrosses",
]

def map_espn(name): return ESPN_TEAM_MAP.get(name, name)
def map_sched(name): return SCHED_TEAM_MAP.get(name, name)

def fetch_json(url):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def sb_get(path):
    req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}")
    for k, v in SB_HEADERS.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def sb_patch(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}", data=body, method="PATCH")
    for k, v in SB_HEADERS.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req) as r:
        return r.status

def main():
    games = sb_get("schedule?status=eq.FT&select=id,home_team,away_team,match_date&order=id")
    print(f"Found {len(games)} finished games")

    dates = sorted(set(g["match_date"] for g in games))
    espn_events = {}

    for d in dates:
        date_str = d.replace("-", "")
        try:
            data = fetch_json(f"{ESPN_API}/scoreboard?dates={date_str}")
            for ev in data.get("events", []):
                comps = ev.get("competitions", [{}])[0]
                teams = comps.get("competitors", [])
                home = next((t["team"]["displayName"] for t in teams if t.get("homeAway") == "home"), "")
                away = next((t["team"]["displayName"] for t in teams if t.get("homeAway") == "away"), "")
                home, away = map_espn(home), map_espn(away)
                espn_events[f"{home}|{away}"] = ev["id"]
                espn_events[f"{away}|{home}"] = ev["id"]
        except Exception as e:
            print(f"  Error fetching scoreboard for {d}: {e}")
        time.sleep(0.3)

    print(f"Found {len(espn_events)//2} ESPN events")

    updated = 0
    for g in games:
        home = map_sched(g["home_team"])
        away = map_sched(g["away_team"])
        key = f"{home}|{away}"
        event_id = espn_events.get(key)
        if not event_id:
            print(f"  No ESPN event for {home} vs {away}")
            continue

        try:
            data = fetch_json(f"{ESPN_API}/summary?event={event_id}")
        except Exception as e:
            print(f"  Failed summary for {event_id}: {e}")
            continue

        bs_teams = data.get("boxscore", {}).get("teams", [])
        rosters = data.get("rosters", [])

        if len(bs_teams) < 2:
            print(f"  No boxscore for {home} vs {away}")
            continue

        home_idx = 0 if bs_teams[0].get("homeAway") == "home" else 1
        away_idx = 1 - home_idx

        def extract_stats(t):
            stats = {}
            for s in t.get("statistics", []):
                if s["name"] in STAT_KEYS:
                    stats[s["name"]] = s.get("displayValue", s.get("value", ""))
            return stats

        formations = {}
        for ros in rosters:
            tn = map_espn(ros.get("team", {}).get("displayName", ""))
            formations[tn] = ros.get("formation", "")

        home_tn = map_espn(bs_teams[home_idx].get("team", {}).get("displayName", ""))
        away_tn = map_espn(bs_teams[away_idx].get("team", {}).get("displayName", ""))

        match_stats = {
            "home": {"team": home_tn, "formation": formations.get(home_tn, ""), "stats": extract_stats(bs_teams[home_idx])},
            "away": {"team": away_tn, "formation": formations.get(away_tn, ""), "stats": extract_stats(bs_teams[away_idx])},
        }

        try:
            sb_patch(f"schedule?id=eq.{g['id']}", {"match_stats": match_stats})
            updated += 1
            hp = match_stats["home"]["stats"].get("possessionPct", "?")
            ap = match_stats["away"]["stats"].get("possessionPct", "?")
            print(f"  {home} vs {away}: {hp}% - {ap}% possession")
        except Exception as e:
            print(f"  Error updating {home} vs {away}: {e}")

        time.sleep(0.5)

    print(f"\nDone! Updated {updated}/{len(games)} games")

if __name__ == "__main__":
    main()
