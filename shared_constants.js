// Shared constants used across all pages
const SB_URL     = 'https://hsanauyxexbyefmefhcd.supabase.co';
const SB_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2ODA2NjEsImV4cCI6MjA5NzI1NjY2MX0.aJ9sMKG1JPW9Umy5gz2dFdhXhVTWxh3Epemgf1MZVK0';
const SB_SVC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4';
const ADMIN      = 'TJ';
const CONTENDERS = ['Eivind','Mari','Benny','Martin','TJ','Helle','Øyvind'];
const WC_API     = 'https://corsproxy.io/?url=https://worldcup26.ir';
const BASE_URL   = 'https://cltj.github.io/wc26';

const FLAG_MAP = {
  'Mexico':'🇲🇽','South Africa':'🇿🇦','South Korea':'🇰🇷','Czechia':'🇨🇿',
  'Canada':'🇨🇦','Bosnia & Herz.':'🇧🇦','Qatar':'🇶🇦','Switzerland':'🇨🇭',
  'Brazil':'🇧🇷','Morocco':'🇲🇦','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Haiti':'🇭🇹',
  'USA':'🇺🇸','Paraguay':'🇵🇾','Australia':'🇦🇺','Türkiye':'🇹🇷',
  'Germany':'🇩🇪',"Côte d'Ivoire":'🇨🇮','Ecuador':'🇪🇨','Curaçao':'🇨🇼',
  'Netherlands':'🇳🇱','Japan':'🇯🇵','Sweden':'🇸🇪','Tunisia':'🇹🇳',
  'Belgium':'🇧🇪','Egypt':'🇪🇬','IR Iran':'🇮🇷','New Zealand':'🇳🇿',
  'Spain':'🇪🇸','Cabo Verde':'🇨🇻','Saudi Arabia':'🇸🇦','Uruguay':'🇺🇾',
  'France':'🇫🇷','Senegal':'🇸🇳','Iraq':'🇮🇶','Norway':'🇳🇴',
  'Argentina':'🇦🇷','Algeria':'🇩🇿','Austria':'🇦🇹','Jordan':'🇯🇴',
  'Portugal':'🇵🇹','DR Congo':'🇨🇩','Uzbekistan':'🇺🇿','Colombia':'🇨🇴',
  'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Croatia':'🇭🇷','Ghana':'🇬🇭','Panama':'🇵🇦',
  // Name aliases
  'Korea Republic':'🇰🇷','Bosnia-Herzegovina':'🇧🇦',
  'Czech Republic':'🇨🇿','Bosnia and Herzegovina':'🇧🇦','United States':'🇺🇸',
  'Turkey':'🇹🇷','Ivory Coast':'🇨🇮','Iran':'🇮🇷','Cape Verde':'🇨🇻',
  'Democratic Republic of the Congo':'🇨🇩',
};

// PLAYER_PHOTOS now loaded from participants table (photo_url column)

// ── Supabase helpers ─────────────────────────────────────────────────────────
async function sb(path, opts={}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...opts.headers
    },
    ...opts
  });
  if (!res.ok) throw new Error(await res.text());
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function sbAdmin(path, opts={}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SB_SVC_KEY,
      'Authorization': `Bearer ${SB_SVC_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...opts.headers
    },
    ...opts
  });
  if (!res.ok) throw new Error(await res.text());
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
function getUser()    { return localStorage.getItem('wc_user'); }
function setUser(u)   { localStorage.setItem('wc_user', u); }
function clearUser()  { localStorage.removeItem('wc_user'); }

async function verifyPin(name, pin) {
  const rows = await sb(`participants?name=eq.${encodeURIComponent(name)}&pin=eq.${encodeURIComponent(pin)}&select=name`);
  return rows && rows.length > 0;
}

// ── Tournament teams helper ──────────────────────────────────────────────────
// Fetches teams_helper joined with national_teams, returns flat array
async function loadTournamentTeams(tournament = 'FIFA.WORLD') {
  const rows = await sb(`teams_helper?select=team_id,group_letter,eliminated,last_formation,last_starting_xi,last_substitutes,national_teams(id,name,flag_emoji,confederation)&tournament=eq.${encodeURIComponent(tournament)}&order=group_letter`);
  return rows.map(r => ({
    id: r.national_teams.id,
    name: r.national_teams.name,
    flag_emoji: r.national_teams.flag_emoji,
    confederation: r.national_teams.confederation,
    group_letter: r.group_letter,
    eliminated: r.eliminated,
    last_formation: r.last_formation,
    last_starting_xi: r.last_starting_xi,
    last_substitutes: r.last_substitutes,
  })).sort((a, b) => (a.group_letter || '').localeCompare(b.group_letter || '') || a.name.localeCompare(b.name));
}

// ── Scoring ──────────────────────────────────────────────────────────────────
function isValidScore(s) {
  if (!s) return false;
  const parts = s.trim().split('-');
  if (parts.length !== 2) return false;
  const [a, b] = parts.map(Number);
  return !isNaN(a) && !isNaN(b) && Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0;
}

function isKnockout(game) {
  return game.round && game.round !== 'group';
}

function isDraw(score) {
  if (!score || !isValidScore(score)) return false;
  const [a, b] = score.trim().split('-').map(Number);
  return a === b;
}

// Calculate points for a prediction
// game: {result, round, advancer}  pred: {prediction, winner}
function calcPts(game, pred) {
  const result = game.result;
  const prediction = typeof pred === 'string' ? pred : pred?.prediction;
  if (!result || !prediction || !isValidScore(prediction)) return null;

  let pts = 0;
  if (result.trim() === prediction.trim()) pts = 3;
  else {
    const [rh,ra] = result.trim().split('-').map(Number);
    const [ph,pa] = prediction.trim().split('-').map(Number);
    const sign = x => x>0?1:x<0?-1:0;
    if (sign(rh-ra) === sign(ph-pa)) pts = 1;
  }

  // Knockout bonus: +1 for correctly picking the advancing team on a draw
  if (isKnockout(game) && isDraw(result) && isDraw(prediction) && game.advancer) {
    const pickedWinner = typeof pred === 'object' ? pred?.winner : null;
    if (pickedWinner && pickedWinner === game.advancer) pts += 1;
  }

  return pts;
}

function predStatus(game, pred) {
  const result = game.result || (typeof game === 'string' ? game : null);
  const prediction = typeof pred === 'string' ? pred : pred?.prediction;
  if (!result) return 'pending';
  if (!prediction || !isValidScore(prediction)) return 'missed';
  // Use simple version for status label
  if (result.trim() === prediction.trim()) return 'exact';
  const [rh,ra] = result.trim().split('-').map(Number);
  const [ph,pa] = prediction.trim().split('-').map(Number);
  const sign = x => x>0?1:x<0?-1:0;
  if (sign(rh-ra) === sign(ph-pa)) return 'winner';
  return 'wrong';
}

function buildLeaderboard(games, predictions) {
  const totals = {};
  CONTENDERS.forEach(n => totals[n] = {pts:0,exact:0,winner:0,wrong:0,missed:0,played:0,bonus:0});
  games.forEach(g => {
    if (!g.result) return;
    CONTENDERS.forEach(n => {
      const p = predictions.find(p => p.game_id===g.id && p.participant===n);
      const status = predStatus(g, p?.prediction);
      if (status==='missed') { totals[n].missed++; }
      else if (status!=='pending') {
        const pts = calcPts(g, p);
        totals[n].pts += pts;
        totals[n].played++;
        if (status==='exact') totals[n].exact++;
        else if (status==='winner') totals[n].winner++;
        else totals[n].wrong++;
        // Track knockout winner bonus
        if (isKnockout(g) && isDraw(g.result) && isDraw(p?.prediction) && g.advancer && p?.winner === g.advancer) {
          totals[n].bonus++;
        }
      }
    });
  });
  return Object.entries(totals).sort((a,b) => b[1].pts - a[1].pts);
}
