#!/usr/bin/env python3
"""One-time backfill of assists, yellow cards, and red cards from ESPN API into Supabase."""

import json
import urllib.request
import time
import unicodedata

SB_URL = 'https://hsanauyxexbyefmefhcd.supabase.co'
SB_SVC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4'

ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world'

# ESPN team name → Supabase team name
TEAM_MAP = {
    'South Korea': 'South Korea',
    'Korea Republic': 'South Korea',
    'Czechia': 'Czechia',
    'Czech Republic': 'Czechia',
    'Bosnia-Herzegovina': 'Bosnia & Herz.',
    'Bosnia and Herzegovina': 'Bosnia & Herz.',
    'United States': 'USA',
    'USA': 'USA',
    'Türkiye': 'Türkiye',
    'Turkey': 'Türkiye',
    'Ivory Coast': "Côte d'Ivoire",
    "Côte d'Ivoire": "Côte d'Ivoire",
    'Curaçao': 'Curaçao',
    'Iran': 'IR Iran',
    'IR Iran': 'IR Iran',
    'Cape Verde': 'Cabo Verde',
    'Cabo Verde': 'Cabo Verde',
    'Congo DR': 'DR Congo',
    'DR Congo': 'DR Congo',
    'Democratic Republic of the Congo': 'DR Congo',
}

def map_team(name):
    return TEAM_MAP.get(name, name)

def norm(s):
    """Normalize for matching: strip diacritics + special chars."""
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.replace('ø', 'o').replace('Ø', 'O').replace('æ', 'ae').replace('Æ', 'AE')
    s = s.replace('å', 'a').replace('Å', 'A').replace('ð', 'd').replace('ß', 'ss')
    return s.lower()

def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def sb_get(path):
    url = f'{SB_URL}/rest/v1/{path}'
    req = urllib.request.Request(url, headers={
        'apikey': SB_SVC_KEY,
        'Authorization': f'Bearer {SB_SVC_KEY}',
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def sb_patch(path, data):
    url = f'{SB_URL}/rest/v1/{path}'
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method='PATCH', headers={
        'apikey': SB_SVC_KEY,
        'Authorization': f'Bearer {SB_SVC_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def match_player(espn_name, team, players_by_team):
    """Match an ESPN player name to a Supabase player."""
    team_players = players_by_team.get(team, [])
    s_norm = norm(espn_name)
    s_parts = s_norm.replace('.', '').split()
    s_last = s_parts[-1] if s_parts else ''

    for pl in team_players:
        p_norm = norm(pl['name'])
        p_parts = p_norm.replace('.', ' ').replace('-', ' ').split()

        # Exact match
        if s_norm == p_norm:
            return pl

        # Last name match (at least 3 chars to avoid false positives)
        if s_last and len(s_last) >= 3 and any(p == s_last for p in p_parts):
            return pl

        # Full containment
        if p_norm in s_norm or s_norm in p_norm:
            return pl

        # Multi-part match
        if len(s_parts) >= 2:
            long_parts = [p for p in s_parts if len(p) > 1]
            if long_parts and all(any(pp == sp or pp.startswith(sp) for pp in p_parts) for sp in long_parts):
                return pl

        # Try name_on_shirt
        if pl.get('name_on_shirt'):
            sh_norm = norm(pl['name_on_shirt'])
            sh_parts = sh_norm.replace('.', ' ').replace('-', ' ').split()
            if s_last and len(s_last) >= 3 and any(p == s_last for p in sh_parts):
                return pl
            if sh_norm in s_norm or s_norm in sh_norm:
                return pl

    return None

def main():
    # Step 1: Get all finished ESPN match IDs
    print("Fetching match IDs from ESPN...")
    match_ids = []
    for date in ['20260611','20260612','20260613','20260614','20260615',
                 '20260616','20260617','20260618','20260619','20260620']:
        try:
            data = fetch_json(f'{ESPN_API}/scoreboard?dates={date}')
            for e in data.get('events', []):
                status = e.get('status', {}).get('type', {}).get('name', '')
                if status == 'STATUS_FULL_TIME':
                    match_ids.append((e['id'], e['name']))
        except Exception as ex:
            pass
        time.sleep(0.2)

    print(f"Found {len(match_ids)} finished matches")

    # Step 2: Load all players from Supabase
    print("Loading players from Supabase...")
    all_players = []
    offset = 0
    while True:
        batch = sb_get(f'players?select=id,name,name_on_shirt,team_name,assists,yellow_cards,red_cards&order=team_name&limit=500&offset={offset}')
        if not batch:
            break
        all_players.extend(batch)
        if len(batch) < 500:
            break
        offset += 500

    players_by_team = {}
    for p in all_players:
        t = p['team_name']
        if t not in players_by_team:
            players_by_team[t] = []
        players_by_team[t].append(p)

    print(f"Loaded {len(all_players)} players across {len(players_by_team)} teams")

    # Step 3: Reset all assists/cards to 0
    print("Resetting all assists/yellow_cards/red_cards to 0...")
    sb_patch('players?assists=gt.-1', {'assists': 0, 'yellow_cards': 0, 'red_cards': 0})
    # Also reset local cache
    for p in all_players:
        p['assists'] = 0
        p['yellow_cards'] = 0
        p['red_cards'] = 0

    # Step 4: Fetch events for each match and aggregate
    # Aggregate: player_id -> {assists, yellows, reds}
    stats = {}  # player_id -> {assists: int, yellow_cards: int, red_cards: int}
    unmatched = []

    for mid, mname in match_ids:
        print(f"\n  {mname} (ID: {mid})")
        try:
            data = fetch_json(f'{ESPN_API}/summary?event={mid}')
        except Exception as ex:
            print(f"    ERROR fetching: {ex}")
            continue

        events = data.get('keyEvents', [])
        for e in events:
            t = e.get('type', {})
            tt = t.get('type', '')

            is_yellow = tt == 'yellow-card'
            is_red = tt in ('red-card', 'yellow-red-card')
            is_goal = 'goal' in tt

            if not (is_yellow or is_red or is_goal):
                continue

            participants = e.get('participants', [])
            team_info = e.get('team', {})
            team_name = map_team(team_info.get('displayName', ''))

            if not participants:
                continue

            athlete = participants[0].get('athlete', {})
            athlete_name = athlete.get('displayName', '')
            clock = e.get('clock', {}).get('displayValue', '')

            if not athlete_name:
                continue

            if is_yellow or is_red:
                player = match_player(athlete_name, team_name, players_by_team)
                if player:
                    pid = player['id']
                    if pid not in stats:
                        stats[pid] = {'assists': 0, 'yellow_cards': 0, 'red_cards': 0, 'name': player['name']}
                    if is_yellow:
                        stats[pid]['yellow_cards'] += 1
                        print(f"    🟨 {clock} {athlete_name} ({team_name}) -> {player['name']}")
                    else:
                        stats[pid]['red_cards'] += 1
                        print(f"    🟥 {clock} {athlete_name} ({team_name}) -> {player['name']}")
                else:
                    unmatched.append(f"{athlete_name} ({team_name}) [{tt}]")
                    print(f"    ❌ {clock} {athlete_name} ({team_name}) - UNMATCHED")

            if is_goal:
                # Check for assist - it's often the second participant
                if len(participants) > 1:
                    assist_athlete = participants[1].get('athlete', {})
                    assist_name = assist_athlete.get('displayName', '')
                    if assist_name:
                        player = match_player(assist_name, team_name, players_by_team)
                        if player:
                            pid = player['id']
                            if pid not in stats:
                                stats[pid] = {'assists': 0, 'yellow_cards': 0, 'red_cards': 0, 'name': player['name']}
                            stats[pid]['assists'] += 1
                            print(f"    🎯 {clock} assist: {assist_name} ({team_name}) -> {player['name']}")
                        else:
                            unmatched.append(f"{assist_name} ({team_name}) [assist]")
                            print(f"    ❌ {clock} assist: {assist_name} ({team_name}) - UNMATCHED")

        time.sleep(0.3)  # Be nice to ESPN API

    # Step 5: Write aggregated stats to Supabase
    print(f"\n{'='*60}")
    print(f"Writing {len(stats)} player stat updates to Supabase...")
    updated = 0
    for pid, s in stats.items():
        updates = {}
        if s['assists'] > 0:
            updates['assists'] = s['assists']
        if s['yellow_cards'] > 0:
            updates['yellow_cards'] = s['yellow_cards']
        if s['red_cards'] > 0:
            updates['red_cards'] = s['red_cards']
        if updates:
            try:
                sb_patch(f'players?id=eq.{pid}', updates)
                updated += 1
            except Exception as ex:
                print(f"  ERROR updating {s['name']} (id={pid}): {ex}")

    print(f"\n✅ Done! Updated {updated} players")

    total_yellows = sum(s['yellow_cards'] for s in stats.values())
    total_reds = sum(s['red_cards'] for s in stats.values())
    total_assists = sum(s['assists'] for s in stats.values())
    print(f"   Yellow cards: {total_yellows}")
    print(f"   Red cards: {total_reds}")
    print(f"   Assists: {total_assists}")

    if unmatched:
        print(f"\n⚠️  Unmatched ({len(unmatched)}):")
        for u in unmatched:
            print(f"   {u}")

if __name__ == '__main__':
    main()
