#!/usr/bin/env python3
"""
ESPN Player Collection Pipeline

Fetches club rosters from ESPN and upserts players into Supabase.
Designed to run incrementally — only re-fetches clubs older than FRESHNESS_HOURS.

Usage:
  python3 scripts/collect_players.py                  # fetch stale clubs (default: 24h)
  python3 scripts/collect_players.py --league eng.1   # only Premier League
  python3 scripts/collect_players.py --limit 10       # max 10 clubs per run
  python3 scripts/collect_players.py --freshness 168  # re-fetch if older than 7 days
  python3 scripts/collect_players.py --all             # ignore freshness, fetch everything
"""

import argparse
import json
import math
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
REQUEST_DELAY = 1.0  # seconds between ESPN API calls

# ESPN citizenship name → our national_teams.name
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
            print(f'  ⚠ Rate limited, waiting 60s...')
            time.sleep(60)
            resp = urllib.request.urlopen(req)
            return json.loads(resp.read())
        raise

def inches_to_cm(inches):
    if not inches:
        return None
    return round(inches * 2.54)

def lbs_to_kg(lbs):
    if not lbs:
        return None
    return round(lbs * 0.453592)

def parse_dob(dob_str):
    if not dob_str:
        return None
    try:
        return dob_str[:10]  # "1999-12-10T08:00Z" → "1999-12-10"
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

    # Load national teams for nationality mapping
    nat_teams = sb_get('national_teams?select=id,name&order=name')
    nat_by_name = {t['name']: t['id'] for t in nat_teams}

    # Load club teams to process
    club_filter = 'club_teams?select=id,espn_team_id,name,league_espn_code,roster_updated_at&order=roster_updated_at.nullsfirst,name'
    if args.league:
        club_filter += f'&league_espn_code=eq.{urllib.parse.quote(args.league.upper())}'
    clubs = sb_get(club_filter)

    # Filter by freshness
    now = datetime.now(timezone.utc)
    if not args.all:
        def is_stale(club):
            if not club.get('roster_updated_at'):
                return True
            updated = datetime.fromisoformat(club['roster_updated_at'].replace('Z', '+00:00'))
            age_hours = (now - updated).total_seconds() / 3600
            return age_hours > args.freshness
        clubs = [c for c in clubs if is_stale(c)]

    if args.limit:
        clubs = clubs[:args.limit]

    print(f'Processing {len(clubs)} clubs (freshness: {args.freshness}h)')

    stats = {'clubs': 0, 'players_upserted': 0, 'errors': 0, 'skipped': 0}

    for i, club in enumerate(clubs):
        espn_id = club['espn_team_id']
        league = club['league_espn_code']

        print(f'[{i+1}/{len(clubs)}] {club["name"]} ({league}, espn:{espn_id})...', end=' ', flush=True)

        try:
            url = f'{ESPN_BASE}/{league.lower()}/teams/{espn_id}/roster'
            data = espn_fetch(url)
            athletes = data.get('athletes', [])

            if not athletes:
                print(f'0 players (empty roster)')
                stats['skipped'] += 1
                # Still mark as fetched so we don't retry immediately
                sb_patch('club_teams', f'id=eq.{club["id"]}', {'roster_updated_at': now.isoformat()})
                time.sleep(REQUEST_DELAY)
                continue

            # Build player records
            player_rows = []
            for a in athletes:
                espn_player_id = int(a.get('id', 0))
                if not espn_player_id:
                    continue

                # Map nationality
                citizenship = a.get('citizenship', '')
                mapped_name = NATIONALITY_MAP.get(citizenship, citizenship)
                nationality_id = nat_by_name.get(mapped_name)

                if not nationality_id and citizenship:
                    # Try fuzzy: check if citizenship is a substring of any team name
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
                    'current_club_id': club['id'],
                    'image_url': ESPN_HEADSHOT.format(espn_id=espn_player_id),
                    'updated_at': now.isoformat(),
                }

                player_rows.append(row)

            if player_rows:
                sb_upsert('players', player_rows, on_conflict='espn_id')
                stats['players_upserted'] += len(player_rows)

            # Mark club as fetched
            sb_patch('club_teams', f'id=eq.{club["id"]}', {'roster_updated_at': now.isoformat()})
            stats['clubs'] += 1
            print(f'{len(player_rows)} players')

        except urllib.error.HTTPError as e:
            body = e.read().decode()[:200] if hasattr(e, 'read') else ''
            print(f'ERROR: {e} — {body}')
            stats['errors'] += 1
        except Exception as e:
            print(f'ERROR: {e}')
            stats['errors'] += 1

        time.sleep(REQUEST_DELAY)

    print(f'\nDone: {stats["clubs"]} clubs, {stats["players_upserted"]} players upserted, {stats["errors"]} errors, {stats["skipped"]} empty rosters')
    return stats

# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Collect player data from ESPN')
    parser.add_argument('--league', help='Only fetch clubs from this league (e.g. eng.1)')
    parser.add_argument('--limit', type=int, help='Max clubs to process per run')
    parser.add_argument('--freshness', type=int, default=24, help='Re-fetch if older than N hours (default: 24)')
    parser.add_argument('--all', action='store_true', help='Ignore freshness, fetch everything')
    args = parser.parse_args()
    collect(args)
