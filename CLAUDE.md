# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FIFA World Cup 2026 prediction league app for a group of five participants (Eivind, Mari, Benny, Martin, TJ). Users predict match scores, earn points, and compete on a leaderboard. Hosted on GitHub Pages at https://cltj.github.io/wc26/.

## Tech Stack

- **Frontend:** Single-file vanilla HTML/CSS/JS (`index.html`, ~1000 lines, no framework, no build step)
- **Backend:** Supabase (PostgreSQL + REST API)
- **Edge Function:** Deno-based sync function (`supabase/functions/sync/index.ts`) that uses Anthropic Claude API with web search to fetch live tournament data
- **Hosting:** GitHub Pages (static)

## Running Locally

```bash
# No build step needed. Either open index.html directly or:
python3 -m http.server 8000
# Then visit http://localhost:8000
```

## Architecture

Everything lives in `index.html` — styles, markup, and all JavaScript. Key sections:

1. **Leaderboard** — Calculates scores from predictions vs results, ranks players
2. **Games List** — Expandable cards showing matches, prediction grids, and input forms
3. **Group Stage** — 12 groups (A-L) with standings computed from game results
4. **Knockout Bracket** — SVG-rendered tournament bracket
5. **Player Search** — Filterable/sortable squad browser (paginated, 500 rows/batch from Supabase)
6. **Admin Section** — Result entry (TJ only)

### Data Flow

- `loadAll()` fetches games + predictions in parallel from Supabase, then renders leaderboard and games
- `loadSquads()` paginates through the `players` table separately
- Group standings are derived from a hardcoded `GROUPS` object + game results
- Predictions lock at kickoff time; only admin (TJ) can save results

### Supabase Tables

- **games** — id, home, away, result, kickoff
- **predictions** — game_id, participant, prediction (format: "2-1")
- **participants** — name, pin (for login)
- **players** — shirt_number, name, position, team_name, club, goals, assists, yellow_cards, red_cards
- **teams** — name, group_letter, flag_emoji

### Scoring Logic

- 3 points: exact score match
- 1 point: correct result direction (win/draw/loss)
- 0 points: wrong prediction

### Key Constants (in index.html JS)

- `SB_URL` / `SB_KEY` — Supabase connection (anon key, public)
- `ADMIN = 'TJ'` — only admin user
- `CONTENDERS` — the five participants
- `GROUPS` — hardcoded group assignments
- `FLAG_MAP` — country name to flag emoji mapping

## Edge Function (supabase/functions/sync/index.ts) — WIP

Still under active development. Calls Claude API with web search to fetch live WC 2026 data (results, standings, stats), then upserts into Supabase. The goal is to trigger it from an admin update button in the UI. Requires env vars: `ANTHROPIC_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Deployment

Push to `main` branch — GitHub Pages serves from the repo root. Images are also hosted on GitHub Pages (`https://cltj.github.io/wc26/*.jpg`).

## Style Conventions

- Dark green football pitch theme (CSS variables: `--pitch`, `--card`, `--gold`, etc.)
- Norway matches get special red accent highlighting (`--norway: #ef2b2d`)
- Fonts: Bebas Neue (headers), Inter (body), JetBrains Mono (data)
- Mobile responsive at 600px breakpoint
