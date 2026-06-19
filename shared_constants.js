// Shared constants used across all pages
const SB_URL     = 'https://hsanauyxexbyefmefhcd.supabase.co';
const SB_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2ODA2NjEsImV4cCI6MjA5NzI1NjY2MX0.aJ9sMKG1JPW9Umy5gz2dFdhXhVTWxh3Epemgf1MZVK0';
const SB_SVC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzYW5hdXl4ZXhieWVmbWVmaGNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTY4MDY2MSwiZXhwIjoyMDk3MjU2NjYxfQ.F0PPYAgFDk_EXjJcXfJFK5CXmGLHrCICkrwG9DFihM4';
const ADMIN      = 'TJ';
const CONTENDERS = ['Eivind','Mari','Benny','Martin','TJ','Helle'];
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
  // worldcup26.ir API name aliases
  'Czech Republic':'🇨🇿','Bosnia and Herzegovina':'🇧🇦','United States':'🇺🇸',
  'Turkey':'🇹🇷','Ivory Coast':'🇨🇮','Iran':'🇮🇷','Cape Verde':'🇨🇻',
  'Democratic Republic of the Congo':'🇨🇩',
};

const PLAYER_PHOTOS = {
  'Eivind': `${BASE_URL}/eivind.jpeg`,
  'TJ':     `${BASE_URL}/tj.jpg`,
  'Mari':   `${BASE_URL}/mari.jpeg`,
  'Benny':  `${BASE_URL}/placeholder.jpg`,
  'Martin': `${BASE_URL}/martin.png`,
  'Helle':  `${BASE_URL}/placeholder.jpg`,
};

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

// ── Scoring ──────────────────────────────────────────────────────────────────
function isValidScore(s) {
  if (!s) return false;
  const parts = s.trim().split('-');
  if (parts.length !== 2) return false;
  const [a, b] = parts.map(Number);
  return !isNaN(a) && !isNaN(b) && Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0;
}

function calcPts(result, pred) {
  if (!result) return null;
  if (!pred || !isValidScore(pred)) return null;
  if (result.trim() === pred.trim()) return 3;
  try {
    const [rh,ra] = result.trim().split('-').map(Number);
    const [ph,pa] = pred.trim().split('-').map(Number);
    const sign = x => x>0?1:x<0?-1:0;
    if (sign(rh-ra) === sign(ph-pa)) return 1;
  } catch(e) {}
  return 0;
}

function predStatus(result, pred) {
  if (!result) return 'pending';
  if (!pred || !isValidScore(pred)) return 'missed';
  const pts = calcPts(result, pred);
  return pts===3?'exact':pts===1?'winner':'wrong';
}

function buildLeaderboard(games, predictions) {
  const totals = {};
  CONTENDERS.forEach(n => totals[n] = {pts:0,exact:0,winner:0,wrong:0,missed:0,played:0});
  games.forEach(g => {
    if (!g.result) return;
    CONTENDERS.forEach(n => {
      const p = predictions.find(p => p.game_id===g.id && p.participant===n);
      const status = predStatus(g.result, p?.prediction);
      if (status==='missed') { totals[n].missed++; }
      else if (status!=='pending') {
        const pts = calcPts(g.result, p?.prediction);
        totals[n].pts += pts;
        totals[n].played++;
        if (status==='exact') totals[n].exact++;
        else if (status==='winner') totals[n].winner++;
        else totals[n].wrong++;
      }
    });
  });
  return Object.entries(totals).sort((a,b) => b[1].pts - a[1].pts);
}
