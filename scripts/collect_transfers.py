#!/usr/bin/env python3
"""
ESPN Transfer Collection Pipeline

Scrapes transfer data from ESPN's transfers page and upserts into Supabase.
Links transfers to players and clubs via ESPN IDs.

Usage:
  python3 scripts/collect_transfers.py --league eng.1 --season 2025
  python3 scripts/collect_transfers.py --league eng.1 --season 2025 --dry-run
  python3 scripts/collect_transfers.py --all-leagues --season 2025
  python3 scripts/collect_transfers.py --league eng.1 --from-season 2020 --to-season 2025
"""

import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

SB_URL = 'https://hsanauyxexbyefmefhcd.supabase.co'
SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4'

REQUEST_DELAY = 1.5  # be nice to ESPN

# Leagues that have transfer pages on ESPN (domestic leagues only)
TRANSFER_LEAGUES = [
    'ENG.1', 'ENG.2', 'ESP.1', 'ESP.2', 'GER.1', 'GER.2',
    'ITA.1', 'ITA.2', 'FRA.1', 'FRA.2', 'NED.1', 'POR.1',
    'BEL.1', 'TUR.1', 'AUT.1', 'GRE.1', 'SCO.1',
    'USA.1', 'MEX.1', 'BRA.1', 'ARG.1',
    'KSA.1', 'AUS.1',
]

# ── Supabase helpers ──────────────────────────────────────────────────────────

def sb_get(path):
    req = urllib.request.Request(
        f'{SB_URL}/rest/v1/{path}',
        headers={'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}'}
    )
    return json.loads(urllib.request.urlopen(req).read())

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
    return json.loads(urllib.request.urlopen(req).read())

# ── ESPN scraper ──────────────────────────────────────────────────────────────

FEE_MAP = {
    'Free': 'free',
    'Loan': 'loan',
    'Undisclosed': 'transfer',
    'Swap': 'transfer',
}

def parse_fee(fee_str):
    """Parse ESPN fee string into (type, fee_eur)."""
    fee_str = fee_str.strip()
    if fee_str in FEE_MAP:
        return FEE_MAP[fee_str], None

    # Parse amounts like "€ 20M", "€3.5M", "£15M", "$8M"
    m = re.match(r'[€£$]\s*([\d.]+)\s*M', fee_str)
    if m:
        amount = float(m.group(1)) * 1_000_000
        return 'transfer', amount

    m = re.match(r'[€£$]\s*([\d,.]+)\s*K', fee_str)
    if m:
        amount = float(m.group(1).replace(',', '')) * 1_000
        return 'transfer', amount

    return 'transfer', None

def parse_transfer_date(date_str, season_year):
    """Convert 'Sep 1' to a full date using the season year context."""
    try:
        month_str, day_str = date_str.strip().split(' ', 1)
        month_map = {
            'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
            'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
        }
        month = month_map.get(month_str)
        day = int(day_str)
        if not month:
            return None
        # For cross-year seasons: Jul-Dec = season_year, Jan-Jun = season_year+1
        year = season_year if month >= 7 else season_year + 1
        return f'{year}-{month:02d}-{day:02d}'
    except Exception:
        return None

def scrape_transfers(league, season_year):
    """Scrape all transfer pages for a league/season."""
    transfers = []
    page = 1

    while True:
        url = f'https://www.espn.com/soccer/transfers/_/league/{league}/season/{season_year}/page/{page}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

        try:
            resp = urllib.request.urlopen(req)
            html = resp.read().decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            raise

        tbody_matches = re.findall(r'<tbody[^>]*>(.*?)</tbody>', html, re.DOTALL)
        if not tbody_matches:
            break

        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', tbody_matches[0], re.DOTALL)
        if not rows:
            break

        for row in rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) < 6:
                continue

            date_text = re.sub(r'<[^>]+>', '', cells[0]).strip()

            # Player
            player_match = re.search(r'/soccer/player/_/id/(\d+)', cells[1])
            player_name = re.sub(r'<[^>]+>', ' ', cells[1]).strip()
            player_name = re.sub(r'\s+', ' ', player_name)
            player_espn_id = player_match.group(1) if player_match else None

            # From team (cell 2) — links use /soccer/club/_/id/ or /soccer/team/_/id/
            from_match = re.search(r'/soccer/(?:club|team)/_/id/(\d+)', cells[2])
            from_text = re.sub(r'<[^>]+>', ' ', cells[2]).strip()
            from_text = re.sub(r'\s+', ' ', from_text)
            from_name = re.sub(r'^[A-Z]{2,4}\s+', '', from_text).strip() if 'No team' not in from_text else None
            from_espn_id = from_match.group(1) if from_match else None

            # To team (cell 4, cell 3 is arrow)
            to_match = re.search(r'/soccer/(?:club|team)/_/id/(\d+)', cells[4])
            to_text = re.sub(r'<[^>]+>', ' ', cells[4]).strip()
            to_text = re.sub(r'\s+', ' ', to_text)
            to_name = re.sub(r'^[A-Z]{2,4}\s+', '', to_text).strip() if 'No team' not in to_text else None
            to_espn_id = to_match.group(1) if to_match else None

            # Fee
            fee_text = re.sub(r'<[^>]+>', '', cells[5]).strip()
            transfer_type, fee_eur = parse_fee(fee_text)

            transfer_date = parse_transfer_date(date_text, season_year)

            transfers.append({
                'date': transfer_date,
                'date_text': date_text,
                'player_name': player_name,
                'player_espn_id': player_espn_id,
                'from_name': from_name,
                'from_espn_id': from_espn_id,
                'to_name': to_name,
                'to_espn_id': to_espn_id,
                'type': transfer_type,
                'fee_text': fee_text,
                'fee_eur': fee_eur,
            })

        page += 1
        time.sleep(REQUEST_DELAY)

    return transfers

# ── Main ──────────────────────────────────────────────────────────────────────

def collect(args):
    now = datetime.now(timezone.utc)
    leagues_to_process = TRANSFER_LEAGUES if args.all_leagues else [args.league.upper()]
    from_season = args.from_season or args.season
    to_season = args.to_season or args.season

    print('Loading reference data...')

    # Player index: espn_id → player row id
    players_idx = {}
    offset = 0
    while True:
        batch = sb_get(f'players?select=id,espn_id&espn_id=not.is.null&order=id&offset={offset}&limit=1000')
        for p in batch:
            players_idx[str(p['espn_id'])] = p['id']
        if len(batch) < 1000:
            break
        offset += 1000
    print(f'  {len(players_idx)} players indexed')

    # Club index: espn_team_id → club row id
    clubs = sb_get('club_teams?select=id,espn_team_id')
    clubs_idx = {c['espn_team_id']: c['id'] for c in clubs}
    print(f'  {len(clubs_idx)} clubs indexed')

    # Season index: (league_id, start_year) → season row id
    seasons = sb_get('seasons?select=id,league_id,start_date')
    season_idx = {}
    for s in seasons:
        if s.get('start_date'):
            yr = int(s['start_date'][:4])
            season_idx[(s['league_id'], yr)] = s['id']

    leagues_db = sb_get('leagues?select=id,espn_code')
    league_id_by_code = {l['espn_code']: l['id'] for l in leagues_db}

    total_stats = {'scraped': 0, 'matched': 0, 'unmatched_player': 0, 'inserted': 0, 'errors': 0}

    for league in leagues_to_process:
        for season_year in range(from_season, to_season + 1):
            print(f'\n{"="*60}')
            print(f'{league} season {season_year}')
            print(f'{"="*60}')

            transfers = scrape_transfers(league, season_year)
            print(f'  Scraped {len(transfers)} transfers')
            total_stats['scraped'] += len(transfers)

            if not transfers or args.dry_run:
                if args.dry_run and transfers:
                    for t in transfers[:5]:
                        print(f'  {t["date_text"]:8} {t["player_name"]:25} -> {t["to_name"] or "free agent":20} ({t["type"]}, {t["fee_text"]})')
                    if len(transfers) > 5:
                        print(f'  ... and {len(transfers)-5} more')
                continue

            # Resolve ESPN IDs to our DB IDs and build insert batch
            league_id = league_id_by_code.get(league)
            season_id = season_idx.get((league_id, season_year)) if league_id else None

            batch = []
            for t in transfers:
                player_id = players_idx.get(t['player_espn_id']) if t['player_espn_id'] else None
                from_club_id = clubs_idx.get(t['from_espn_id']) if t['from_espn_id'] else None
                to_club_id = clubs_idx.get(t['to_espn_id']) if t['to_espn_id'] else None

                if not player_id:
                    total_stats['unmatched_player'] += 1
                    continue

                total_stats['matched'] += 1
                batch.append({
                    'player_id': player_id,
                    'from_club_id': from_club_id,
                    'to_club_id': to_club_id,
                    'detected_at': now.isoformat(),
                    'transfer_date': t['date'],
                    'season_id': season_id,
                    'type': t['type'],
                    'fee_eur': t['fee_eur'],
                    'notes': f'{t["player_name"]}: {t["from_name"] or "free"} -> {t["to_name"] or "free"} ({t["fee_text"]})',
                })

            if batch:
                try:
                    sb_upsert('transfers', batch)
                    total_stats['inserted'] += len(batch)
                    print(f'  Inserted {len(batch)} transfers ({total_stats["unmatched_player"]} unmatched players)')
                except urllib.error.HTTPError as e:
                    body = e.read().decode()[:300]
                    print(f'  ERROR inserting: {e.code} {body}')
                    total_stats['errors'] += 1

    print(f'\n{"="*60}')
    print(f'Total: {total_stats["scraped"]} scraped, {total_stats["matched"]} matched, '
          f'{total_stats["unmatched_player"]} unmatched players, '
          f'{total_stats["inserted"]} inserted, {total_stats["errors"]} errors')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Collect transfer data from ESPN')
    parser.add_argument('--league', help='League code (e.g. eng.1)')
    parser.add_argument('--season', type=int, required=True, help='ESPN season year (e.g. 2025 for 2025-26)')
    parser.add_argument('--from-season', type=int, help='Start season year for range (default: same as --season)')
    parser.add_argument('--to-season', type=int, help='End season year for range (default: same as --season)')
    parser.add_argument('--all-leagues', action='store_true', help='Process all known leagues')
    parser.add_argument('--dry-run', action='store_true', help='Scrape and show transfers without inserting')
    args = parser.parse_args()

    if not args.league and not args.all_leagues:
        parser.error('Either --league or --all-leagues is required')

    collect(args)
