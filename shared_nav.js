// ── Shared nav + login modal injected into every page ────────────────────────
const NAV_PAGES = [
  { href:'index.html',   label:'⚽ League',   key:'index'   },
  { href:'groups.html',  label:'🗂 Groups',   key:'groups'  },
  { href:'bracket.html', label:'🏆 Bracket',  key:'bracket' },
  { href:'teams.html',   label:'🌍 Teams',    key:'teams'   },
  { href:'players.html', label:'👤 Players',  key:'players' },
];

function injectNav(activePage) {
  const user = getUser();

  const navLinks = NAV_PAGES.map(p => {
    const active = p.key === activePage ? 'active' : '';
    return `<a href="${p.href}" class="nav-link ${active}">${p.label}</a>`;
  }).join('');

  const adminLink = user === ADMIN
    ? `<a href="admin.html" class="nav-link ${activePage==='admin'?'active':''}">⚙️ Admin</a>`
    : '';

  const userSection = user
    ? `<div class="nav-user">
        <span class="nav-username">${user}</span>
        <button class="nav-logout" onclick="logout()">Sign out</button>
       </div>`
    : `<button class="nav-signin" onclick="openModal()">Sign in</button>`;

  document.body.insertAdjacentHTML('afterbegin', `
    <nav class="site-nav">
      <a href="index.html" class="nav-logo">WC<span>26</span></a>
      <div class="nav-links">${navLinks}${adminLink}</div>
      <div class="nav-actions">${userSection}</div>
      <button class="nav-burger" onclick="toggleMobileNav()">☰</button>
    </nav>
    <div class="nav-mobile" id="nav-mobile">
      ${NAV_PAGES.map(p=>`<a href="${p.href}" class="nav-mobile-link">${p.label}</a>`).join('')}
      ${user===ADMIN?`<a href="admin.html" class="nav-mobile-link">⚙️ Admin</a>`:''}
    </div>

    <!-- Login Modal -->
    <div class="modal-bg hidden" id="modal-bg">
      <div class="modal">
        <div style="font-size:32px;margin-bottom:8px">⚽</div>
        <h2>Sign In</h2>
        <p>Pick your name and enter your PIN to submit predictions</p>
        <select id="login-name">
          <option value="">Select your name…</option>
          ${CONTENDERS.map(n=>`<option>${n}</option>`).join('')}
        </select>
        <input type="password" id="login-pin" placeholder="PIN" maxlength="10" inputmode="numeric">
        <div class="modal-err" id="login-err"></div>
        <button onclick="doLogin()">Sign In</button>
        <div style="margin-top:14px;font-size:11px;color:var(--dim)">
          Just want to watch? <a href="#" onclick="closeModal()" style="color:var(--gold)">Browse as guest</a>
        </div>
      </div>
    </div>
  `);

  document.getElementById('login-pin')?.addEventListener('keydown', e => {
    if (e.key==='Enter') doLogin();
  });
}

function toggleMobileNav() {
  document.getElementById('nav-mobile').classList.toggle('open');
}

function openModal()  { document.getElementById('modal-bg').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal-bg').classList.add('hidden'); }

async function doLogin() {
  const name = document.getElementById('login-name').value;
  const pin  = document.getElementById('login-pin').value;
  const err  = document.getElementById('login-err');
  if (!name) { err.textContent = 'Please select your name.'; return; }
  if (!pin)  { err.textContent = 'Please enter your PIN.'; return; }
  err.textContent = 'Checking…';
  try {
    const ok = await verifyPin(name, pin);
    if (!ok) { err.textContent = 'Wrong PIN — try again.'; return; }
    setUser(name);
    closeModal();
    location.reload();
  } catch(e) { err.textContent = 'Error — try again.'; }
}

function logout() { clearUser(); location.reload(); }
