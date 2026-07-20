#!/usr/bin/env python3
"""
ESPN Transfer Collection Pipeline (per-club)

Scrapes transfer data from ESPN's per-club transfer pages.
More reliable than league-wide pages — direction (in/out) is explicit.

Usage:
  python3 scripts/collect_transfers.py --league eng.1 --season 2025
  python3 scripts/collect_transfers.py --league eng.1 --season 2025 --dry-run
  python3 scripts/collect_transfers.py --season 2025                # all leagues
  python3 scripts/collect_transfers.py --league eng.1 --from-season 2020 --to-season 2025
  python3 scripts/collect_transfers.py --limit 10 --season 2025     # first 10 clubs
"""

import argparse
import json
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

SB_URL = 'https://hsanauyxexbyefmefhcd.supabase.co'
SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4'

REQUEST_DELAY = 1.5

FEE_MAP = {'Free': 'free', 'Loan': 'loan', 'Undisclosed': 'transfer', 'Swap': 'transfer'}

# ── Supabase helpers ──────────────────────────────────────────────────────────

def sb_get(path):
    req = urllib.request.Request(
        f'{SB_URL}/rest/v1/{path}',
        headers={'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}'}
    )
    return json.loads(urllib.request.urlopen(req).read())

def sb_upsert(table, data):
    url = f'{SB_URL}/rest/v1/{table}'
    headers = {
        'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
    }
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method='POST')
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        # If unique constraint conflict, skip silently
        if e.code == 409:
            return []
        raise

# ── Parsing helpers ───────────────────────────────────────────────────────────

def parse_fee(fee_str):
    fee_str = fee_str.strip()
    if fee_str in FEE_MAP:
        return FEE_MAP[fee_str], None
    m = re.match(r'[€£$]\s*([\d.]+)\s*M', fee_str)
    if m:
        return 'transfer', float(m.group(1)) * 1_000_000
    m = re.match(r'[€£$]\s*([\d,.]+)\s*K', fee_str)
    if m:
        return 'transfer', float(m.group(1).replace(',', '')) * 1_000
    return 'transfer', None

def parse_date(date_str, season_year):
    try:
        month_str, day_str = date_str.strip().split(' ', 1)
        months = {'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,
                  'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12}
        month = months.get(month_str)
        if not month:
            return None
        day = int(day_str)
        year = season_year if month >= 7 else season_year + 1
        return f'{year}-{month:02d}-{day:02d}'
    except Exception:
        return None

# ── Per-club scraper ──────────────────────────────────────────────────────────

def scrape_club_transfers(espn_team_id, season_year):
    """Scrape transfers for one club. Returns list of (direction, transfer) tuples."""
    url = f'https://www.espn.com/soccer/team/transfers/_/id/{espn_team_id}/year/{season_year}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    try:
        resp = urllib.request.urlopen(req)
        html = resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError:
        return []

    # Find table headers to determine direction
    theads = re.findall(r'<thead[^>]*>(.*?)</thead>', html, re.DOTALL)
    tbodies = re.findall(r'<tbody[^>]*>(.*?)</tbody>', html, re.DOTALL)

    results = []
    for i, (thead, tbody) in enumerate(zip(theads, tbodies)):
        thead_text = re.sub(r'<[^>]+>', ' ', thead).upper()
        direction = 'in' if 'FROM' in thead_text else 'out'

        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', tbody, re.DOTALL)
        for row in rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) < 4:
                continue

            date_text = re.sub(r'<[^>]+>', '', cells[0]).strip()
            player_match = re.search(r'/soccer/player/_/id/(\d+)', cells[1])
            player_name = re.sub(r'<[^>]+>', ' ', cells[1]).strip()
            player_name = re.sub(r'\s+', ' ', player_name)
            player_espn_id = player_match.group(1) if player_match else None

            other_match = re.search(r'/soccer/(?:club|team)/_/id/(\d+)', cells[2])
            other_espn_id = other_match.group(1) if other_match else None
            other_name = re.sub(r'<[^>]+>', ' ', cells[2]).strip()
            other_name = re.sub(r'\s+', ' ', other_name)
            other_name = re.sub(r'^[A-Z]{2,5}\s+', '', other_name).strip()

            fee_text = re.sub(r'<[^>]+>', '', cells[3]).strip()
            transfer_type, fee_eur = parse_fee(fee_text)
            transfer_date = parse_date(date_text, season_year)

            results.append({
                'direction': direction,
                'player_name': player_name,
                'player_espn_id': player_espn_id,
                'other_club_espn_id': other_espn_id,
                'other_club_name': other_name,
                'date': transfer_date,
                'date_text': date_text,
                'type': transfer_type,
                'fee_text': fee_text,
                'fee_eur': fee_eur,
            })

    return results

# ── Main ──────────────────────────────────────────────────────────────────────

def collect(args):
    now = datetime.now(timezone.utc)
    from_season = args.from_season or args.season
    to_season = args.to_season or args.season

    print('Loading reference data...')

    # Player index
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

    # Club index
    clubs_raw = sb_get('club_teams?select=id,espn_team_id,name,league_espn_code')
    clubs_idx = {c['espn_team_id']: c['id'] for c in clubs_raw}
    print(f'  {len(clubs_idx)} clubs indexed')

    # Season index
    seasons = sb_get('seasons?select=id,league_id,start_date')
    season_idx = {}
    for s in seasons:
        if s.get('start_date'):
            season_idx[(s['league_id'], int(s['start_date'][:4]))] = s['id']

    leagues_db = sb_get('leagues?select=id,espn_code')
    league_id_by_code = {l['espn_code']: l['id'] for l in leagues_db}

    # Filter clubs
    clubs = clubs_raw
    if args.league:
        code = args.league.upper()
        clubs = [c for c in clubs if c['league_espn_code'] == code]
    if args.limit:
        clubs = clubs[:args.limit]

    print(f'Processing {len(clubs)} clubs x {to_season - from_season + 1} season(s)')

    stats = {'clubs': 0, 'scraped': 0, 'inserted': 0, 'unmatched': 0, 'errors': 0, 'skipped': 0}

    for season_year in range(from_season, to_season + 1):
        print(f'\n--- Season {season_year} ---')

        for i, club in enumerate(clubs):
            espn_id = club['espn_team_id']
            league = club['league_espn_code']
            club_id = club['id']

            print(f'[{i+1}/{len(clubs)}] {club["name"]}...', end=' ', flush=True)

            try:
                transfers = scrape_club_transfers(espn_id, season_year)

                if not transfers:
                    print('0 transfers')
                    stats['skipped'] += 1
                    time.sleep(REQUEST_DELAY)
                    continue

                stats['scraped'] += len(transfers)

                if args.dry_run:
                    ins = sum(1 for t in transfers if t['direction'] == 'in')
                    outs = sum(1 for t in transfers if t['direction'] == 'out')
                    print(f'{ins} in, {outs} out')
                    for t in transfers[:3]:
                        arrow = '<-' if t['direction'] == 'in' else '->'
                        print(f'  {t["date_text"]:8} {t["player_name"]:25} {arrow} {t["other_club_name"]:20} ({t["type"]}, {t["fee_text"]})')
                    if len(transfers) > 3:
                        print(f'  ... +{len(transfers)-3} more')
                    time.sleep(REQUEST_DELAY)
                    continue

                league_id = league_id_by_code.get(league)
                season_id = season_idx.get((league_id, season_year)) if league_id else None

                batch = []
                for t in transfers:
                    player_id = players_idx.get(t['player_espn_id']) if t['player_espn_id'] else None
                    other_club_id = clubs_idx.get(t['other_club_espn_id']) if t['other_club_espn_id'] else None

                    if not player_id:
                        stats['unmatched'] += 1
                        continue

                    if t['direction'] == 'in':
                        from_id, to_id = other_club_id, club_id
                    else:
                        from_id, to_id = club_id, other_club_id

                    batch.append({
                        'player_id': player_id,
                        'from_club_id': from_id,
                        'to_club_id': to_id,
                        'detected_at': now.isoformat(),
                        'transfer_date': t['date'],
                        'season_id': season_id,
                        'type': t['type'],
                        'fee_eur': t['fee_eur'],
                        'notes': f'{t["player_name"]}: {t["other_club_name"]} ({t["fee_text"]})',
                    })

                if batch:
                    sb_upsert('transfers', batch)
                    stats['inserted'] += len(batch)

                ins = sum(1 for t in transfers if t['direction'] == 'in')
                outs = sum(1 for t in transfers if t['direction'] == 'out')
                matched = len(batch)
                unmatched = len(transfers) - matched
                print(f'{ins} in, {outs} out ({matched} matched, {unmatched} unmatched)')
                stats['clubs'] += 1

            except urllib.error.HTTPError as e:
                print(f'ERROR {e.code}')
                stats['errors'] += 1
            except Exception as e:
                print(f'ERROR: {e}')
                stats['errors'] += 1

            time.sleep(REQUEST_DELAY)

    print(f'\n{"="*60}')
    print(f'Done: {stats["clubs"]} clubs, {stats["scraped"]} scraped, '
          f'{stats["inserted"]} inserted, {stats["unmatched"]} unmatched, '
          f'{stats["errors"]} errors')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Collect transfer data from ESPN (per-club)')
    parser.add_argument('--league', help='League code (e.g. eng.1). Omit for all leagues.')
    parser.add_argument('--season', type=int, required=True, help='ESPN season year (e.g. 2025)')
    parser.add_argument('--from-season', type=int, help='Start of season range')
    parser.add_argument('--to-season', type=int, help='End of season range')
    parser.add_argument('--limit', type=int, help='Max clubs to process')
    parser.add_argument('--dry-run', action='store_true', help='Scrape without inserting')
    args = parser.parse_args()
    collect(args)
