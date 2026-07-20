#!/usr/bin/env python3
"""
ESPN Player Collection Pipeline

Fetches club rosters from ESPN and upserts players into Supabase.
Detects transfers (club changes), new players, and departures.
Supports season-aware fetching for historical data.

Usage:
  python3 scripts/collect_players.py                  # fetch stale clubs, current season
  python3 scripts/collect_players.py --league eng.1   # only Premier League
  python3 scripts/collect_players.py --limit 10       # max 10 clubs per run
  python3 scripts/collect_players.py --freshness 168  # re-fetch if older than 7 days
  python3 scripts/collect_players.py --all            # ignore freshness, fetch everything
  python3 scripts/collect_players.py --season 2023    # fetch 2023(-24) rosters for all leagues
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

SB_URL = 'https://hsanauyxexbyefmefhcd.supabase.co'
SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4'

ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer'
ESPN_HEADSHOT = 'https://a.espncdn.com/i/headshots/soccer/players/full/{espn_id}.png'
REQUEST_DELAY = 1.0

NATIONALITY_MAP = {
    'United States': 'USA',
    'Ivory Coast': "Côte d'Ivoire",
    'Turkey': 'Türkiye',
    'Iran': 'IR Iran',
    'Czech Republic': 'Czechia',
    'Bosnia and Herzegovina': 'Bosnia & Herz.',
    'Cape Verde': 'Cabo Verde',
    'Republic of Ireland': 'Ireland',
    'Korea Republic': 'South Korea',
    'Congo DR': 'DR Congo',
    'Democratic Republic of the Congo': 'DR Congo',
    'Cote d\'Ivoire': "Côte d'Ivoire",
    'Curacao': 'Curaçao',
    'China PR': 'China',
    'Northern Ireland': 'Northern Ireland',
    'Trinidad and Tobago': 'Trinidad & Tobago',
    'St Kitts and Nevis': 'St. Kitts & Nevis',
    'Antigua and Barbuda': 'Antigua & Barbuda',
    'Bosnia-Herzegovina': 'Bosnia & Herz.',
}

# ── Supabase helpers ──────────────────────────────────────────────────────────

def sb_get(path):
    req = urllib.request.Request(
        f'{SB_URL}/rest/v1/{path}',
        headers={'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}'}
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

def sb_upsert(table, data, on_conflict=None):
    url = f'{SB_URL}/rest/v1/{table}'
    headers = {
        'apikey': SB_KEY,
        'Authorization': f'Bearer {SB_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
    }
    if on_conflict:
        url += f'?on_conflict={on_conflict}'
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method='POST')
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

def sb_post(table, data, ignore_conflict=False):
    url = f'{SB_URL}/rest/v1/{table}'
    headers = {
        'apikey': SB_KEY,
        'Authorization': f'Bearer {SB_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
    }
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method='POST')
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if ignore_conflict and e.code == 409:
            return []
        raise

def sb_patch(table, filters, data):
    url = f'{SB_URL}/rest/v1/{table}?{filters}'
    headers = {
        'apikey': SB_KEY,
        'Authorization': f'Bearer {SB_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
    }
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method='PATCH')
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

# ── ESPN helpers ──────────────────────────────────────────────────────────────

def espn_fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print(f'  Rate limited, waiting 60s...')
            time.sleep(60)
            resp = urllib.request.urlopen(req)
            return json.loads(resp.read())
        raise

def inches_to_cm(inches):
    return round(inches * 2.54) if inches else None

def lbs_to_kg(lbs):
    return round(lbs * 0.453592) if lbs else None

def parse_dob(dob_str):
    if not dob_str:
        return None
    try:
        return dob_str[:10]
    except Exception:
        return None

def position_abbr(pos_obj):
    if not pos_obj:
        return None
    abbr = pos_obj.get('abbreviation', '')
    return {'G': 'GK', 'D': 'DF', 'M': 'MF', 'F': 'FW'}.get(abbr, abbr)

# ── Main collection logic ────────────────────────────────────────────────────

def collect(args):
    print('Loading reference data...')
    now = datetime.now(timezone.utc)

    nat_teams = sb_get('national_teams?select=id,name&order=name')
    nat_by_name = {t['name']: t['id'] for t in nat_teams}

    # Load seasons — if --season given, find matching seasons; otherwise use current
    all_seasons = sb_get('seasons?select=id,league_id,label,start_date')
    season_by_league = {}
    if args.season:
        # Match seasons whose start_date year equals the requested year
        for s in all_seasons:
            if s.get('start_date') and s['start_date'][:4] == str(args.season):
                season_by_league[s['league_id']] = s
    else:
        current = sb_get('seasons?select=id,league_id,label,start_date&is_current=eq.true')
        for s in current:
            season_by_league[s['league_id']] = s

    leagues = sb_get('leagues?select=id,espn_code')
    league_id_by_code = {l['espn_code']: l['id'] for l in leagues}
    league_code_by_id = {l['id']: l['espn_code'] for l in leagues}

    # Load existing players for transfer detection
    print('Loading existing player index...')
    existing_players = {}
    offset = 0
    while True:
        batch = sb_get(f'players?select=id,espn_id,current_club_id&espn_id=not.is.null&order=id&offset={offset}&limit=1000')
        for p in batch:
            existing_players[str(p['espn_id'])] = p
        if len(batch) < 1000:
            break
        offset += 1000
    print(f'  {len(existing_players)} existing players indexed')

    # Load clubs
    club_filter = 'club_teams?select=id,espn_team_id,name,league_espn_code,roster_updated_at&order=roster_updated_at.nullsfirst,name'
    if args.league:
        club_filter += f'&league_espn_code=eq.{urllib.parse.quote(args.league.upper())}'
    clubs = sb_get(club_filter)

    # Filter by freshness (skip for historical season fetches)
    if not args.all and not args.season:
        def is_stale(club):
            if not club.get('roster_updated_at'):
                return True
            updated = datetime.fromisoformat(club['roster_updated_at'].replace('Z', '+00:00'))
            age_hours = (now - updated).total_seconds() / 3600
            return age_hours > args.freshness
        clubs = [c for c in clubs if is_stale(c)]

    if args.limit:
        clubs = clubs[:args.limit]

    # Determine ESPN season year per league
    espn_season = {}  # league_espn_code → year int
    for lid, s in season_by_league.items():
        code = league_code_by_id.get(lid)
        if code and s.get('start_date'):
            espn_season[code] = int(s['start_date'][:4])

    is_historical = bool(args.season)
    print(f'Processing {len(clubs)} clubs (freshness: {args.freshness}h, season: {args.season or "current"})')

    stats = {'clubs': 0, 'players_upserted': 0, 'transfers': 0, 'new_players': 0, 'errors': 0, 'skipped': 0}
    seen_on_roster = {}

    for i, club in enumerate(clubs):
        espn_id = club['espn_team_id']
        league = club['league_espn_code']
        club_id = club['id']

        print(f'[{i+1}/{len(clubs)}] {club["name"]} ({league}, espn:{espn_id})...', end=' ', flush=True)

        try:
            url = f'{ESPN_BASE}/{league.lower()}/teams/{espn_id}/roster'
            yr = espn_season.get(league.upper())
            if yr:
                url += f'?season={yr}'

            data = espn_fetch(url)
            athletes = data.get('athletes', [])
            espn_season_info = data.get('season', {}).get('displayName', '')

            if not athletes:
                print(f'0 players ({espn_season_info or "empty"})')
                stats['skipped'] += 1
                if not is_historical:
                    sb_patch('club_teams', f'id=eq.{club_id}', {'roster_updated_at': now.isoformat()})
                time.sleep(REQUEST_DELAY)
                continue

            player_rows = []
            roster_espn_ids = set()
            transfer_records = []

            league_id = league_id_by_code.get(league.upper())
            season = season_by_league.get(league_id)
            season_id = season['id'] if season else None

            for a in athletes:
                espn_player_id = int(a.get('id', 0))
                if not espn_player_id:
                    continue

                espn_id_str = str(espn_player_id)
                roster_espn_ids.add(espn_id_str)

                citizenship = a.get('citizenship', '')
                mapped_name = NATIONALITY_MAP.get(citizenship, citizenship)
                nationality_id = nat_by_name.get(mapped_name)

                if not nationality_id and citizenship:
                    for tname, tid in nat_by_name.items():
                        if citizenship.lower() in tname.lower() or tname.lower() in citizenship.lower():
                            nationality_id = tid
                            break

                row = {
                    'espn_id': espn_player_id,
                    'name': a.get('fullName') or a.get('displayName', ''),
                    'first_name': a.get('firstName', ''),
                    'last_name': a.get('lastName', ''),
                    'short_name': a.get('shortName', ''),
                    'date_of_birth': parse_dob(a.get('dateOfBirth')),
                    'nationality_id': nationality_id,
                    'primary_position': position_abbr(a.get('position')),
                    'height_cm': inches_to_cm(a.get('height')),
                    'weight_kg': lbs_to_kg(a.get('weight')),
                    'image_url': ESPN_HEADSHOT.format(espn_id=espn_player_id),
                    'updated_at': now.isoformat(),
                }

                # Update current_club_id for current season or if --update-clubs
                if not is_historical or args.update_clubs:
                    row['current_club_id'] = club_id

                player_rows.append(row)

                # Detect transfers (only for current season)
                if not is_historical:
                    prev = existing_players.get(espn_id_str)
                    if prev:
                        old_club = prev.get('current_club_id')
                        if old_club and old_club != club_id:
                            transfer_records.append({
                                'player_id': prev['id'],
                                'from_club_id': old_club,
                                'to_club_id': club_id,
                                'detected_at': now.isoformat(),
                                'season_id': season_id,
                                'type': 'transfer',
                                'notes': row['name'],
                            })
                            stats['transfers'] += 1
                    else:
                        stats['new_players'] += 1

            if player_rows:
                result = sb_upsert('players', player_rows, on_conflict='espn_id')
                stats['players_upserted'] += len(player_rows)

                if not is_historical:
                    for r in result:
                        existing_players[str(r['espn_id'])] = {
                            'id': r['id'],
                            'espn_id': r['espn_id'],
                            'current_club_id': r['current_club_id'],
                        }

            if transfer_records:
                try:
                    sb_post('transfers', transfer_records, ignore_conflict=True)
                except Exception as e:
                    print(f' (transfer log error: {e})', end='')

            seen_on_roster[club_id] = roster_espn_ids

            if not is_historical:
                sb_patch('club_teams', f'id=eq.{club_id}', {'roster_updated_at': now.isoformat()})
            stats['clubs'] += 1

            detail = f'{len(player_rows)} players'
            if transfer_records:
                detail += f', {len(transfer_records)} transfers'
            if espn_season_info:
                detail += f' [{espn_season_info}]'
            print(detail)

        except urllib.error.HTTPError as e:
            body = ''
            try:
                body = e.read().decode()[:200]
            except Exception:
                pass
            print(f'ERROR {e.code}: {body[:80] if body else e.reason}')
            stats['errors'] += 1
        except Exception as e:
            print(f'ERROR: {e}')
            stats['errors'] += 1

        time.sleep(REQUEST_DELAY)

    # Detect departures (only for current full-league fetches)
    if seen_on_roster and not args.league and not is_historical:
        print('\nChecking for departures...')
        departed = 0
        for club_id, roster_ids in seen_on_roster.items():
            for espn_id_str, player in existing_players.items():
                if player.get('current_club_id') == club_id and espn_id_str not in roster_ids:
                    league_id = None
                    for c in clubs:
                        if c['id'] == club_id:
                            league_id = league_id_by_code.get(c['league_espn_code'].upper())
                            break
                    sid = season_by_league.get(league_id, {}).get('id') if league_id else None
                    try:
                        sb_post('transfers', [{
                            'player_id': player['id'],
                            'from_club_id': club_id,
                            'to_club_id': None,
                            'detected_at': now.isoformat(),
                            'season_id': sid,
                            'type': 'unknown',
                            'notes': f'No longer on roster (espn_id: {espn_id_str})',
                        }])
                        departed += 1
                    except Exception:
                        pass
        if departed:
            print(f'  {departed} players departed from fetched clubs')
            stats['transfers'] += departed

    print(f'\nDone: {stats["clubs"]} clubs, {stats["players_upserted"]} players, '
          f'{stats["new_players"]} new, {stats["transfers"]} transfers, '
          f'{stats["errors"]} errors, {stats["skipped"]} empty rosters')
    return stats

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Collect player data from ESPN')
    parser.add_argument('--league', help='Only fetch clubs from this league (e.g. eng.1)')
    parser.add_argument('--limit', type=int, help='Max clubs to process per run')
    parser.add_argument('--freshness', type=int, default=24, help='Re-fetch if older than N hours (default: 24)')
    parser.add_argument('--all', action='store_true', help='Ignore freshness, fetch everything')
    parser.add_argument('--season', type=int, help='ESPN season year (e.g. 2023 for 2023-24). Skips freshness and transfer detection.')
    parser.add_argument('--update-clubs', action='store_true', help='Update current_club_id even in historical mode')
    args = parser.parse_args()
    collect(args)
