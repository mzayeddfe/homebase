/* app.js — interface, local storage and GitHub sync. */
(function () {
  'use strict';
  const R = window.Rota;
  const LS_STATE = 'chores.state.v1';
  const LS_SYNC = 'chores.sync.v1';
  const LS_ME = 'chores.me.v1';
  const CAT_LABEL = { disinfect: 'Disinfecting', organise: 'Organising', neutral: 'General' };
  const FREQ_LABEL = { daily: 'Every day', weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Every 4 weeks' };
  const LEAN = { A: 'Disinfecting lean', B: 'Organising lean' };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ---------- State ---------- */
  // meals and ingredients are reserved for the planned cooking rota and shopping list.
  function defaultState() {
    return {
      version: 1,
      people: { A: { name: 'Person A' }, B: { name: 'Person B' } },
      chores: clone(R.DEFAULT_CHORES),
      configAt: 0,      // when people/chores were last edited; newest wins when syncing
      done: {},         // instanceKey -> { v: true|false, by: 'A'|'B'|'', at: ISO time }
      moves: {},        // instanceKey -> { person: 'A'|'B'|'', day: 0-6 or -1, at: ISO time }  (reassigned tasks)
      meals: [],
      ingredients: [],
    };
  }
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ } }

  let state = Object.assign(defaultState(), readJSON(LS_STATE) || {});
  const LS_UNLOCK = 'chores.unlock.v1';
  const EMPTY_SYNC = { owner: '', repo: '', path: 'chores.json', branch: 'main', token: '' };

  // Logins: config.js (optional) holds the sync details encrypted with each person's password.
  // Two formats: v1 = one household password; v2 = a password per person ("users"), which also says who is logged in.
  const RAW_LOCK = window.CHORES_LOCK;
  const LOCK = RAW_LOCK && (RAW_LOCK.data || RAW_LOCK.users) ? RAW_LOCK : null;
  const LOGINS = !!(LOCK && LOCK.users);
  const lockId = LOCK ? (LOGINS ? LOCK.salt : LOCK.data.slice(0, 32)) : '';
  let savedMe = '';
  let unlocked = !LOCK;
  let keepUnlocked = true;
  let sync = Object.assign({}, EMPTY_SYNC, LOCK ? {} : readJSON(LS_SYNC) || {});
  if (LOCK) {
    let saved = readJSON(LS_UNLOCK);
    try { saved = saved || JSON.parse(sessionStorage.getItem(LS_UNLOCK)); } catch { /* blocked */ }
    if (saved && saved.lock === lockId && saved.sync) {
      sync = Object.assign({}, EMPTY_SYNC, saved.sync); keepUnlocked = !!saved.keep; unlocked = true;
      savedMe = saved.me || '';
      if (LOGINS && savedMe !== 'A' && savedMe !== 'B') unlocked = false; // old record without a login
    }
  }
  let me = LOGINS ? savedMe : localStorage.getItem(LS_ME) || '';
  let tab = 'today';
  let weekOffset = 0;
  let editingId = null;

  const saveLocal = () => writeJSON(LS_STATE, state);
  const name = (p) => (state.people[p] && state.people[p].name) || `Person ${p}`;
  const isDone = (key) => !!(state.done[key] && state.done[key].v);
  // Who gets the minutes: whoever ticked it, otherwise the person it was assigned to.
  const doer = (it) => { const d = state.done[it.key]; return d && (d.by === 'A' || d.by === 'B') ? d.by : it.person; };
  const credited = (items, p) => items.reduce((s, i) => s + (isDone(i.key) && doer(i) === p ? i.chore.minutes : 0), 0);

  // The rota for week w, with any one-off reassignments applied on top.
  function weekItems(w) {
    const items = R.buildWeek(state.chores, w);
    for (const it of items) {
      it.planned = { person: it.person, day: it.day };
      const mv = state.moves && state.moves[it.key];
      if (mv) {
        if (mv.person === 'A' || mv.person === 'B') it.person = mv.person;
        if (mv.day >= 0 && mv.day <= 6) it.day = mv.day;
      }
      it.moved = it.person !== it.planned.person || it.day !== it.planned.day;
    }
    return items;
  }
  const findItem = (key) => weekItems(Number(key.split(':')[0])).find((i) => i.key === key);

  const touchConfig = () => { state.configAt = Date.now(); saveLocal(); schedulePush(); };

  function merge(local, remote) {
    const out = Object.assign({}, local);
    const newer = (remote.configAt || 0) >= (local.configAt || 0) ? remote : local;
    for (const k of ['people', 'chores', 'configAt', 'meals', 'ingredients']) if (newer[k] !== undefined) out[k] = newer[k];
    out.done = Object.assign({}, local.done || {});
    for (const [k, v] of Object.entries(remote.done || {})) {
      if (!out.done[k] || (v.at || '') > (out.done[k].at || '')) out.done[k] = v;
    }
    out.moves = Object.assign({}, local.moves || {});
    for (const [k, v] of Object.entries(remote.moves || {})) {
      if (!out.moves[k] || (v.at || '') > (out.moves[k].at || '')) out.moves[k] = v;
    }
    return out;
  }

  /* ---------- GitHub sync (private repo, Contents API) ---------- */
  let syncing = false, pending = false, pushTimer = null, lastError = '';
  const syncReady = () => !!(sync.owner && sync.repo && sync.token && sync.path);
  const b64e = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64d = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (ch) => ch.charCodeAt(0)));
  const apiUrl = () => `https://api.github.com/repos/${encodeURIComponent(sync.owner.trim())}/${encodeURIComponent(sync.repo.trim())}/contents/${sync.path.trim().split('/').map(encodeURIComponent).join('/')}`;
  const ghHeaders = () => ({ Authorization: `Bearer ${sync.token.trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

  async function ghError(r) {
    let msg = r.statusText;
    try { msg = (await r.json()).message || msg; } catch { /* not JSON */ }
    if (r.status === 401) return 'GitHub rejected the token. Check it was copied fully and has not expired.';
    if (r.status === 403) return `GitHub refused access (${msg}). Check the token has Contents: read and write on this repo.`;
    if (r.status === 404) return 'Repo or branch not found. Check the owner, repo name and branch, and that the token includes this repo.';
    return `GitHub error ${r.status}: ${msg}`;
  }
  async function remoteGet() {
    const r = await fetch(`${apiUrl()}?ref=${encodeURIComponent(sync.branch || 'main')}`, { headers: ghHeaders(), cache: 'no-store' });
    if (r.status === 404) {
      // Either the file doesn't exist yet (fine) or the repo isn't reachable (check).
      const repo = await fetch(`https://api.github.com/repos/${encodeURIComponent(sync.owner.trim())}/${encodeURIComponent(sync.repo.trim())}`, { headers: ghHeaders(), cache: 'no-store' });
      if (!repo.ok) throw new Error(await ghError(repo));
      return { sha: null, data: null };
    }
    if (!r.ok) throw new Error(await ghError(r));
    const j = await r.json();
    return { sha: j.sha, data: JSON.parse(b64d(j.content)) };
  }
  async function remotePut(data, sha) {
    const body = { message: `Homebase update ${new Date().toISOString()}`, content: b64e(JSON.stringify(data, null, 1)), branch: sync.branch || 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(apiUrl(), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) return false; // someone else saved first; retry
    if (!r.ok) throw new Error(await ghError(r));
    return true;
  }
  function setStatus(s, msg) {
    lastError = s === 'error' ? msg : '';
    const dot = $('#syncDot');
    dot.dataset.s = s;
    dot.title = { off: 'Sync is off: ticks stay on this phone', ok: 'Synced', syncing: 'Syncing…', error: `Sync failed: ${msg}` }[s];
    const line = document.getElementById('syncStatus');
    if (line) { line.textContent = dot.title; line.className = 'status-line' + (s === 'error' ? ' error' : ''); }
  }
  async function pull() {
    if (!syncReady() || syncing) return;
    setStatus('syncing');
    try {
      const { data } = await remoteGet();
      if (data) { state = merge(state, data); saveLocal(); render(true); }
      setStatus('ok');
    } catch (e) { setStatus('error', e.message); }
  }
  async function push() {
    if (!syncReady()) return;
    if (syncing) { pending = true; return; }
    syncing = true; setStatus('syncing');
    try {
      let saved = false;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        const { sha, data } = await remoteGet();
        if (data) state = merge(state, data);
        saved = await remotePut(state, sha);
      }
      if (!saved) throw new Error('Could not save after 3 tries. Tap the dot to try again.');
      saveLocal(); render(true); setStatus('ok');
    } catch (e) { setStatus('error', e.message); }
    finally { syncing = false; if (pending) { pending = false; push(); } }
  }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(push, 700); }

  /* ---------- Logins (AES-GCM, key from PBKDF2-SHA256) ---------- */
  const ITERATIONS = 600000;
  const bytesToB64 = (bytes) => { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptConfig(obj, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITERATIONS);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { v: 1, iterations: ITERATIONS, salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
  }
  async function decryptConfig(lock, password) {
    const key = await deriveKey(password, b64ToBytes(lock.salt), lock.iterations || ITERATIONS);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(lock.iv) }, key, b64ToBytes(lock.data));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function persistSync() {
    if (!LOCK) return writeJSON(LS_SYNC, sync);
    const rec = JSON.stringify({ lock: lockId, sync, keep: keepUnlocked, me: LOGINS ? me : '' });
    try {
      if (keepUnlocked) { localStorage.setItem(LS_UNLOCK, rec); sessionStorage.removeItem(LS_UNLOCK); }
      else { sessionStorage.setItem(LS_UNLOCK, rec); localStorage.removeItem(LS_UNLOCK); }
    } catch { /* storage blocked */ }
  }
  async function unlock() {
    const pass = $('#lock-pass').value;
    const msg = $('#lock-msg');
    if (!pass) return $('#lock-pass').focus();
    $('#unlockBtn').disabled = true; msg.className = 'status-line'; msg.textContent = 'Unlocking…';
    try {
      if (LOGINS) {
        const key = await deriveKey(pass, b64ToBytes(LOCK.salt), LOCK.iterations || ITERATIONS);
        let found = null;
        for (const p of ['A', 'B']) {
          const u = LOCK.users[p];
          if (!u) continue;
          try {
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(u.iv) }, key, b64ToBytes(u.data));
            found = { p, cfg: JSON.parse(new TextDecoder().decode(pt)) }; break;
          } catch { /* not this person's password */ }
        }
        if (!found) throw new Error('wrong');
        me = found.p; sync = Object.assign({}, EMPTY_SYNC, found.cfg);
      } else {
        sync = Object.assign({}, EMPTY_SYNC, await decryptConfig(LOCK, pass));
      }
    } catch {
      $('#unlockBtn').disabled = false; msg.className = 'status-line error'; msg.textContent = 'Wrong password. Try again.';
      $('#lock-pass').select(); return;
    }
    $('#lock-pass').value = '';
    keepUnlocked = $('#lock-keep').checked; unlocked = true; persistSync();
    render(); setStatus('ok'); pull();
  }
  async function makeLockFile() {
    const out = $('#lockOut');
    const pa = $('#l-passA').value, pa2 = $('#l-passA2').value, pb = $('#l-passB').value, pb2 = $('#l-passB2').value;
    const fail = (t) => { out.innerHTML = `<p class="status-line error">${esc(t)}</p>`; };
    if (!syncReady()) return fail('Set up and test sync first: the login file stores those details.');
    if (pa.length < 12 || pb.length < 12) return fail('Each password needs at least 12 characters. Four random words works well.');
    if (pa !== pa2) return fail(`${name('A')}'s two passwords do not match.`);
    if (pb !== pb2) return fail(`${name('B')}'s two passwords do not match.`);
    if (pa === pb) return fail('The two people need different passwords, so the app knows who is logging in.');
    out.innerHTML = '<p class="status-line">Encrypting…</p>';
    const cfg = new TextEncoder().encode(JSON.stringify({ owner: sync.owner, repo: sync.repo, path: sync.path, branch: sync.branch, token: sync.token }));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const users = {};
    for (const [p, pass] of [['A', pa], ['B', pb]]) {
      const key = await deriveKey(pass, salt, ITERATIONS);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      users[p] = { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, cfg))) };
    }
    const lock = { v: 2, iterations: ITERATIONS, salt: bytesToB64(salt), users };
    const text = `// Encrypted sync settings for Homebase, one login per person. Safe to keep in a public repo.\nwindow.CHORES_LOCK = ${JSON.stringify(lock)};\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); a.download = 'config.js';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    out.innerHTML = `<p class="status-line">config.js downloaded. Upload it to the app repo next to index.html. If the download didn't start, copy this into a new file called config.js:</p>
      <label class="f">config.js<textarea readonly id="lockText">${esc(text)}</textarea></label>
      <button class="btn ghost" id="copyLock">Copy</button>`;
    ['#l-passA', '#l-passA2', '#l-passB', '#l-passB2'].forEach((sel) => { $(sel).value = ''; });
  }

  /* ---------- Actions ---------- */
  function toggle(key) {
    const it = findItem(key);
    state.done[key] = { v: !isDone(key), by: me || (it ? it.person : ''), at: new Date().toISOString() };
    saveLocal(); render(); schedulePush();
  }

  /* ---------- Rendering helpers ---------- */
  const order = () => (me === 'B' ? ['B', 'A'] : ['A', 'B']);
  const fmtDate = (d, opts) => d.toLocaleDateString('en-GB', opts);

  function tiles(items) {
    const planned = items.reduce((s, i) => s + i.chore.minutes, 0);
    const done = items.reduce((s, i) => s + (isDone(i.key) ? i.chore.minutes : 0), 0);
    const cells = Math.max(6, Math.ceil(planned / 5));
    let html = '';
    for (let n = 0; n < cells; n++) {
      const m = n * 5;
      const cls = n >= 6 ? 'over' : m < done ? 'done' : m < planned ? 'plan' : '';
      html += `<span class="${cls}"></span>`;
    }
    return `<div class="tiles" style="grid-template-columns:repeat(${cells},1fr)" aria-hidden="true">${html}</div>
      <div class="tile-label">${done} of ${planned} min done${planned > R.DAILY_CAP ? ' (over 30)' : ''}</div>`;
  }

  function tagsFor(ch) {
    return `<span class="tag ${esc(ch.cat)}${ch.heavy ? ' heavy' : ''}">${CAT_LABEL[ch.cat] || 'General'}${ch.heavy ? ', daunting' : ''}</span>
      <span>${ch.minutes} min</span>`;
  }

  function taskRow(it, compact) {
    const done = isDone(it.key);
    const who = doer(it);
    const byOther = done && who !== it.person ? `<span class="credit" data-p="${who}">done by ${esc(name(who))}</span>` : '';
    const moved = it.moved ? `<span class="moved">${it.planned.person !== it.person ? `from ${esc(name(it.planned.person))}` : 'moved'}</span>` : '';
    const label = `${done ? 'Untick' : 'Tick'} ${it.chore.name}`;
    return `<li class="task${done ? ' done' : ''}">
      <button class="check" data-key="${esc(it.key)}" aria-pressed="${done}" aria-label="${esc(label)}">✓</button>
      <div class="t-body">
        <button class="t-name link" data-task="${esc(it.key)}">${esc(it.chore.name)}</button>
        ${compact ? (byOther || moved ? `<div class="t-meta">${byOther}${moved}</div>` : '')
          : `<div class="t-meta">${tagsFor(it.chore)}${byOther}${moved}<button class="mini" data-task="${esc(it.key)}">Reassign</button></div>`}
        ${!compact && it.chore.notes ? `<details class="how"><summary>How to</summary><p>${esc(it.chore.notes)}</p></details>` : ''}
      </div></li>`;
  }

  /* ---------- Views ---------- */
  function viewToday() {
    const now = new Date();
    const w = R.weekIndexOf(now), d = R.dayIndexOf(now);
    const week = weekItems(w);
    let html = '';
    if (!me) {
      html += `<div class="banner"><h3>Whose phone is this?</h3>
        <p class="lede" style="margin:6px 0 10px">Your chores will show first.</p>
        <div class="row"><button class="btn" data-me="A">${esc(name('A'))}</button><button class="btn" data-me="B">${esc(name('B'))}</button></div></div>`;
    }
    html += `<h2>${esc(fmtDate(now, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>`;
    for (const p of order()) {
      const todays = week.filter((i) => i.person === p && i.day === d);
      const missed = week.filter((i) => i.person === p && i.day < d && !isDone(i.key));
      html += `<section class="person" data-p="${p}">
        <div class="person-head"><h3>${esc(name(p))}</h3><span class="lean">${LEAN[p]}</span>${me === p ? '<span class="you">You</span>' : ''}</div>
        ${tiles(todays)}
        <div class="tile-label">This week: ${credited(week, p)} min of cleaning done</div>
        <ul class="tasks">${todays.map((i) => taskRow(i)).join('') || '<li class="empty">Nothing today.</li>'}</ul>
        ${missed.length ? `<details class="how" style="margin:4px 0 10px"><summary>${missed.length} left from earlier this week</summary>
          <ul class="tasks">${missed.map((i) => taskRow(i)).join('')}</ul></details>` : ''}
      </section>`;
    }
    return html;
  }

  function viewWeek() {
    const nowW = R.weekIndexOf(new Date());
    const w = nowW + weekOffset;
    const monday = R.mondayOfWeek(w);
    const week = weekItems(w);
    const todayIdx = weekOffset === 0 ? R.dayIndexOf(new Date()) : -1;
    const label = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week'
      : `Week of ${fmtDate(monday, { day: 'numeric', month: 'short' })}`;
    let html = `<div class="week-nav">
      <button class="icon-btn" data-week="-1" aria-label="Previous week">‹</button>
      <div class="label">${label}<div style="font:400 14px var(--body);color:var(--muted)">from ${esc(fmtDate(monday, { weekday: 'short', day: 'numeric', month: 'short' }))}</div></div>
      <button class="icon-btn" data-week="1" aria-label="Next week">›</button></div>`;
    if (weekOffset !== 0) html += `<div class="row" style="justify-content:center;margin:-4px 0 12px"><button class="btn ghost" data-week="0">Back to this week</button></div>`;

    html += '<div class="summary">';
    for (const p of order()) {
      const mine = week.filter((i) => i.person === p);
      const total = mine.reduce((s, i) => s + i.chore.minutes, 0);
      const done = credited(week, p);
      const covered = week.filter((i) => i.person !== p && isDone(i.key) && doer(i) === p).reduce((s, i) => s + i.chore.minutes, 0);
      html += `<div class="person" data-p="${p}"><h3>${esc(name(p))}</h3>
        <div class="tile-label" style="margin:4px 0 0">${done} min done of ${total} assigned</div>
        <div class="bar"><i style="width:${total ? Math.min(100, Math.round((done / total) * 100)) : 0}%"></i></div>
        ${covered ? `<div class="tile-label" style="margin:6px 0 0">Includes ${covered} min covering for ${esc(name(p === 'A' ? 'B' : 'A'))}</div>` : ''}</div>`;
    }
    html += '</div>';

    for (let d = 0; d < 7; d++) {
      const date = new Date(monday); date.setDate(monday.getDate() + d);
      html += `<section class="day${d === todayIdx ? ' today' : ''}"><div class="day-head"><h3>${esc(fmtDate(date, { weekday: 'long', day: 'numeric' }))}</h3>${d === todayIdx ? '<span class="tile-label">Today</span>' : ''}</div><div class="day-cols">`;
      for (const p of order()) {
        const items = week.filter((i) => i.person === p && i.day === d);
        const mins = items.reduce((s, i) => s + i.chore.minutes, 0);
        html += `<div class="col" data-p="${p}"><div class="col-head"><span>${esc(name(p))}</span><span class="${mins > R.DAILY_CAP ? 'over' : ''}">${mins} min</span></div>
          <ul class="tasks">${items.map((i) => taskRow(i, true)).join('') || '<li class="empty">Free</li>'}</ul></div>`;
      }
      html += '</div></section>';
    }
    return html;
  }

  function viewChores() {
    const w = R.weekIndexOf(new Date());
    const week = weekItems(w);
    const tot = (p) => week.filter((i) => i.person === p).reduce((s, i) => s + i.chore.minutes, 0);
    let html = `<h2>Chores</h2><p class="lede">Tap a chore to change it. This week: ${esc(name('A'))} ${tot('A')} min, ${esc(name('B'))} ${tot('B')} min.</p>
      <div class="row" style="margin:0 0 14px"><button class="btn" id="addChore">Add chore</button></div>`;
    for (const f of ['daily', 'weekly', 'fortnightly', 'monthly']) {
      const list = state.chores.filter((ch) => ch.freq === f);
      if (!list.length) continue;
      html += `<h2>${FREQ_LABEL[f]}</h2>`;
      for (const ch of list) {
        const who = ch.owner ? `Always ${esc(name(ch.owner))}` : f === 'daily' ? 'Alternates daily' : 'On the rota';
        const day = Number(ch.day) >= 0 ? `<span>${R.DAYS[ch.day]}</span>` : '';
        html += `<button class="chore-row" data-edit="${esc(ch.id)}"><div class="t-name">${esc(ch.name)}</div>
          <div class="t-meta">${tagsFor(ch)}<span>${who}</span>${day}</div></button>`;
      }
    }
    return html;
  }

  function viewLock() {
    return `<section class="card" style="margin-top:18px">
      <h2 style="margin-top:0">${LOGINS ? 'Log in' : 'Enter the household password'}</h2>
      ${LOGINS ? '<p class="hint" style="margin:0 0 12px">Use your own password. It tells Homebase who you are.</p>' : ''}
      <label class="f">${LOGINS ? 'Your password' : 'Password'}<input id="lock-pass" type="password" autocomplete="current-password" autofocus></label>
      <label class="inline"><input type="checkbox" id="lock-keep" checked> ${LOGINS ? 'Keep me logged in on this device' : 'Keep this phone unlocked'}</label>
      <button class="btn" id="unlockBtn">${LOGINS ? 'Log in' : 'Unlock'}</button>
      <p class="status-line" id="lock-msg"></p>
    </section>`;
  }

  function lockSection() {
    const head = LOGINS
      ? `<h3>Logins are on</h3><p class="hint" style="margin:6px 0 12px">To change a password or the token, create a new login file below and replace config.js in the app repo. Everyone then logs in again.</p>`
      : LOCK
        ? `<h3>Switch to personal logins</h3><p class="hint" style="margin:6px 0 12px">You're using one household password. Give each person their own password instead, and Homebase will know who is ticking without setting up each phone.</p>`
        : `<h3>Logins</h3><p class="hint" style="margin:6px 0 12px">Give each person their own password. Anyone with the link sees only a login box, and the password decides who is logged in, on any phone or laptop.</p>`;
    const pw = (p) => `<label class="f">${esc(name(p))}'s password<input id="l-pass${p}" type="password" autocomplete="new-password"></label>
      <label class="f">${esc(name(p))}'s password again<input id="l-pass${p}2" type="password" autocomplete="new-password"></label>`;
    return `<section class="card">${head}
      ${pw('A')}${pw('B')}
      <p class="hint">At least 12 characters each, and different from each other. Four random words, like "kettle orbit maple drum", is strong and easy to type.</p>
      <button class="btn" id="makeLock">Create login file</button>
      <div id="lockOut"></div>
    </section>`;
  }

  function viewSettings() {
    return `<h2>Settings</h2>
    <section class="card"><h3>People</h3><p class="hint" style="margin:6px 0 12px">A leans towards disinfecting chores, B towards organising.</p>
      <div class="two">
        <label class="f">Person A<input id="s-nameA" value="${esc(name('A'))}" maxlength="24"></label>
        <label class="f">Person B<input id="s-nameB" value="${esc(name('B'))}" maxlength="24"></label>
      </div>
      ${LOGINS
        ? `<p class="hint" style="margin:0 0 12px">Logged in as <strong>${esc(name(me))}</strong>.</p>`
        : `<label class="f">This phone belongs to<select id="s-me">
        <option value="">Not set</option>
        <option value="A"${me === 'A' ? ' selected' : ''}>${esc(name('A'))}</option>
        <option value="B"${me === 'B' ? ' selected' : ''}>${esc(name('B'))}</option>
      </select></label>`}
      <button class="btn" id="s-savePeople">Save people</button>
    </section>

    <section class="card"><h3>Sync between phones</h3>
      <p class="hint" style="margin:6px 0 12px">Ticks and chore changes are saved to a file in your private GitHub repo. See the README for setup.</p>
      <div class="two">
        <label class="f">GitHub username<input id="s-owner" value="${esc(sync.owner)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="f">Private repo<input id="s-repo" value="${esc(sync.repo)}" placeholder="homebase-data" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      </div>
      <div class="two">
        <label class="f">File<input id="s-path" value="${esc(sync.path)}" autocapitalize="off" spellcheck="false"></label>
        <label class="f">Branch<input id="s-branch" value="${esc(sync.branch)}" autocapitalize="off" spellcheck="false"></label>
      </div>
      <label class="f">Access token<input id="s-token" type="password" value="${esc(sync.token)}" autocomplete="off" placeholder="github_pat_…"></label>
      <div class="row"><button class="btn" id="s-saveSync">Save and sync</button>${LOCK ? '' : '<button class="btn ghost" id="s-stopSync">Turn off sync</button>'}</div>
      <p class="status-line" id="syncStatus"></p>
    </section>
    ${lockSection()}

    <section class="card"><h3>Data</h3>
      <p class="hint" style="margin:6px 0 12px">Back up everything as a file, or restore from one.</p>
      <div class="row">
        <button class="btn ghost" id="s-export">Download backup</button>
        <label class="btn ghost" style="display:inline-block">Restore backup<input id="s-import" type="file" accept="application/json" hidden></label>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn danger" id="s-resetChores">Reset chores to defaults</button>
        <button class="btn danger" id="s-clearTicks">Clear all ticks</button>
      </div>
    </section>`;
  }

  function render(fromSync) {
    // Don't wipe a half-typed settings form when a background sync lands.
    if (fromSync && tab === 'settings' && document.activeElement && document.activeElement.closest('#view')) return;
    $('nav.tabs').hidden = !unlocked;
    const who = $('#whoBtn');
    who.hidden = !unlocked || !LOCK;
    who.textContent = LOGINS ? `${name(me)} · Log out` : 'Lock';
    who.dataset.p = LOGINS ? me : '';
    if (!unlocked) { $('#view').innerHTML = viewLock(); return; }
    const scroll = window.scrollY;
    const views = { today: viewToday, week: viewWeek, chores: viewChores, settings: viewSettings };
    $('#view').innerHTML = views[tab]();
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
    if (tab === 'settings') setStatus($('#syncDot').dataset.s, lastError);
    if (fromSync || tab !== 'settings') window.scrollTo(0, scroll);
  }

  /* ---------- Reassign or correct a single task ---------- */
  let taskKey = null;
  function openTask(key) {
    const it = findItem(key);
    if (!it) return;
    taskKey = key;
    const monday = R.mondayOfWeek(Number(key.split(':')[0]));
    $('#taskTitle').textContent = it.chore.name;
    $('#t-info').textContent = `${it.chore.minutes} min. On the rota for ${name(it.planned.person)} on ${R.DAYS[it.planned.day]}.`;
    const opt = (v, t, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
    $('#t-person').innerHTML = opt('A', name('A'), it.person === 'A') + opt('B', name('B'), it.person === 'B');
    $('#t-day').innerHTML = R.DAYS.map((d, i) => {
      const date = new Date(monday); date.setDate(monday.getDate() + i);
      return opt(i, fmtDate(date, { weekday: 'long', day: 'numeric', month: 'short' }), it.day === i);
    }).join('');
    const done = isDone(key), who = doer(it);
    $('#t-done').innerHTML = opt('', 'Not done yet', !done) + opt('A', `Done by ${name('A')}`, done && who === 'A') + opt('B', `Done by ${name('B')}`, done && who === 'B');
    $('#t-reset').hidden = !it.moved;
    $('#taskDlg').showModal();
  }
  function saveTask(reset) {
    const it = findItem(taskKey);
    const at = new Date().toISOString();
    state.moves = state.moves || {};
    if (reset) state.moves[taskKey] = { person: '', day: -1, at };
    else {
      const person = $('#t-person').value, day = Number($('#t-day').value);
      if (person !== it.person || day !== it.day) state.moves[taskKey] = { person, day, at };
      const by = $('#t-done').value;
      if (by !== (isDone(taskKey) ? doer(it) : '')) state.done[taskKey] = { v: !!by, by, at };
    }
    $('#taskDlg').close(); saveLocal(); render(); schedulePush();
  }

  /* ---------- Chore editor ---------- */
  function fillOffsets(freq, value) {
    const n = freq === 'fortnightly' ? 2 : freq === 'monthly' ? 4 : 0;
    $('#f-offset-wrap').hidden = n === 0;
    const curW = R.weekIndexOf(new Date());
    let opts = '';
    for (let i = 0; i < n; i++) {
      // Show when each option next falls, which is easier than "week 2 of 4".
      let wk = curW; while (((wk % n) + n) % n !== i) wk++;
      opts += `<option value="${i}">${wk === curW ? 'This week' : 'From ' + fmtDate(R.mondayOfWeek(wk), { day: 'numeric', month: 'short' })}</option>`;
    }
    $('#f-offset').innerHTML = opts;
    if (n) $('#f-offset').value = String(Math.min(Number(value) || 0, n - 1));
  }
  function openEditor(id) {
    editingId = id;
    const ch = state.chores.find((c) => c.id === id) || { name: '', minutes: 10, freq: 'weekly', cat: 'neutral', owner: '', day: -1, offset: 0, heavy: false, notes: '' };
    $('#editTitle').textContent = id ? 'Edit chore' : 'Add chore';
    $('#f-name').value = ch.name; $('#f-minutes').value = ch.minutes; $('#f-freq').value = ch.freq;
    $('#f-cat').value = ch.cat; $('#f-owner').value = ch.owner || ''; $('#f-day').value = String(ch.day ?? -1);
    $('#f-heavy').checked = !!ch.heavy; $('#f-notes').value = ch.notes || '';
    $('#f-owner').options[1].text = `Always ${name('A')}`; $('#f-owner').options[2].text = `Always ${name('B')}`;
    fillOffsets(ch.freq, ch.offset);
    $('#f-delete').hidden = !id;
    $('#editDlg').showModal();
  }
  function saveEditor() {
    const nm = $('#f-name').value.trim();
    if (!nm) { $('#f-name').focus(); return; }
    const minutes = Math.min(30, Math.max(5, Math.round((Number($('#f-minutes').value) || 10) / 5) * 5));
    const data = {
      name: nm, minutes, freq: $('#f-freq').value, cat: $('#f-cat').value, owner: $('#f-owner').value,
      day: Number($('#f-day').value), offset: Number($('#f-offset').value) || 0, heavy: $('#f-heavy').checked,
      notes: $('#f-notes').value.trim(),
    };
    if (data.freq === 'daily') data.day = -1;
    if (editingId) Object.assign(state.chores.find((c) => c.id === editingId), data);
    else state.chores.push(Object.assign({ id: nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) + '-' + Date.now().toString(36) }, data));
    $('#editDlg').close(); touchConfig(); render();
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-me]');
    if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; if (tab === 'week') weekOffset = 0; render(); window.scrollTo(0, 0); return; }
    if (t.dataset.key) return toggle(t.dataset.key);
    if (t.dataset.task) return openTask(t.dataset.task);
    if (t.dataset.me) { me = t.dataset.me; localStorage.setItem(LS_ME, me); return render(); }
    if (t.dataset.week !== undefined) { weekOffset = t.dataset.week === '0' ? 0 : weekOffset + Number(t.dataset.week); return render(); }
    if (t.dataset.edit) return openEditor(t.dataset.edit);
    switch (t.id) {
      case 'unlockBtn': unlock(); break;
      case 'makeLock': makeLockFile(); break;
      case 'copyLock': $('#lockText').select(); navigator.clipboard && navigator.clipboard.writeText($('#lockText').value); t.textContent = 'Copied'; break;
      case 'whoBtn':
        if (!LOGINS || confirm(`Log out ${name(me)}?`)) {
          try { localStorage.removeItem(LS_UNLOCK); sessionStorage.removeItem(LS_UNLOCK); } catch { /* blocked */ }
          location.reload();
        }
        break;
      case 'lockNow':
        try { localStorage.removeItem(LS_UNLOCK); sessionStorage.removeItem(LS_UNLOCK); } catch { /* blocked */ }
        location.reload(); break;
      case 'syncDot': if (syncReady()) push(); else { tab = 'settings'; render(); } break;
      case 'addChore': openEditor(null); break;
      case 'f-save': saveEditor(); break;
      case 'f-cancel': $('#editDlg').close(); break;
      case 't-save': saveTask(false); break;
      case 't-reset': saveTask(true); break;
      case 't-cancel': $('#taskDlg').close(); break;
      case 'f-delete':
        if (confirm('Delete this chore? Past ticks for it will be kept.')) {
          state.chores = state.chores.filter((c) => c.id !== editingId); $('#editDlg').close(); touchConfig(); render();
        }
        break;
      case 's-savePeople':
        state.people = { A: { name: $('#s-nameA').value.trim() || 'Person A' }, B: { name: $('#s-nameB').value.trim() || 'Person B' } };
        if (!LOGINS) { me = $('#s-me').value; localStorage.setItem(LS_ME, me); }
        touchConfig(); render(); break;
      case 's-saveSync':
        sync = { owner: $('#s-owner').value.trim(), repo: $('#s-repo').value.trim(), path: $('#s-path').value.trim() || 'chores.json',
          branch: $('#s-branch').value.trim() || 'main', token: $('#s-token').value.trim() };
        persistSync();
        if (syncReady()) push(); else setStatus('error', 'Fill in username, repo and token.');
        break;
      case 's-stopSync':
        sync.token = ''; writeJSON(LS_SYNC, sync); setStatus('off'); render(); break;
      case 's-export': {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `homebase-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        break;
      }
      case 's-resetChores':
        if (confirm('Replace all chores with the default list? Your ticks are kept.')) { state.chores = clone(R.DEFAULT_CHORES); touchConfig(); render(); }
        break;
      case 's-clearTicks':
        if (confirm('Clear every tick for both people?')) {
          const at = new Date().toISOString();
          for (const k of Object.keys(state.done)) state.done[k] = { v: false, by: me, at };
          saveLocal(); schedulePush(); render();
        }
        break;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-freq') fillOffsets(e.target.value, 0);
    if (e.target.id === 's-import' && e.target.files[0]) {
      e.target.files[0].text().then((txt) => {
        const data = JSON.parse(txt);
        if (!Array.isArray(data.chores)) throw new Error('missing chores');
        state = Object.assign(defaultState(), data); state.configAt = Date.now();
        saveLocal(); schedulePush(); render(); alert('Backup restored.');
      }).catch(() => alert('That file is not a chore backup.'));
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'lock-pass') unlock(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); pull(); } });
  setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 60000);

  /* ---------- Start ---------- */
  render();
  setStatus(syncReady() ? 'ok' : 'off');
  pull();
})();
