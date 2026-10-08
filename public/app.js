/* Portal front end. Plain ES module, no build step.
 * Every module paints from the last saved copy in localStorage first, then refreshes from the
 * server, so the page is never blank and never shows a spinner first. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================= local storage ================= */
const CACHE_KEY = 'portal-cache-v1';
const LOCAL_KEY = 'portal-local-v1';
let cache = {};
let local = { focus: false };
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch {}
try { local = { ...local, ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') }; } catch {}
function stash(key, value) {
  cache[key] = { value, at: Date.now() };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}
const cached = (key) => cache[key]?.value;
function saveLocal() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch {} }

/* ================= server ================= */
let serverDown = false;
function setOffline(down) {
  serverDown = down;
  $('offline').hidden = !down;
}
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-store', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, ...opts });
  } catch (err) {
    setOffline(true);
    throw err;
  }
  setOffline(false);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* ================= settings ================= */
let S = cached('settings') || null;
let undoSnap = null;
let toastTimer;

function toast(msg, undoable = true) {
  $('toastMsg').textContent = msg;
  $('toastUndo').hidden = !undoable;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 5000);
}

async function persist(next, prev) {
  try {
    S = await api('api/settings', { method: 'PUT', body: JSON.stringify(next) });
    stash('settings', S);
  } catch (err) {
    S = prev;
    renderAll();
    toast(`Couldn't save: ${err.message}`, false);
  }
}

/** Apply a settings change locally right away, save it, and offer Undo. */
function change(msg, fn, after) {
  const prev = structuredClone(S);
  undoSnap = prev;
  fn(S);
  stash('settings', S);
  renderAll();
  toast(msg);
  persist(S, prev).then(() => after?.());
}
$('toastUndo').onclick = () => {
  if (!undoSnap) return;
  const prev = S;
  S = undoSnap;
  undoSnap = null;
  renderAll();
  $('toast').hidden = true;
  persist(S, prev).then(() => refreshAll());
};

/* ================= photo ================= */
let current = null;
let upcoming = null;

const photoUrl = (p, w) => `${p.url}${p.url.includes('?') ? '&' : '?'}auto=format&fit=crop&w=${w}&q=80`;
const screenW = () => Math.min(2560, Math.ceil((innerWidth * (devicePixelRatio || 1)) / 400) * 400);

function hexToHsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
/** Unsplash's per-photo color is an average, usually muddy. Push it to a vivid, readable accent. */
function accentFrom(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#8fb4ff';
  const [h, s] = hexToHsl(hex);
  if (s < 0.07) return '#8fb4ff';
  return `hsl(${Math.round(h)} ${Math.round(Math.max(s, 0.6) * 100)}% 66%)`;
}

/** `ready` means the full-size image is already loaded, so it goes straight in with no blur-up. */
function showPhoto(p, ready = false) {
  if (!p) return;
  current = p;
  const root = document.documentElement.style;
  root.setProperty('--base', p.color || '#3a3f48');
  root.setProperty('--accent', accentFrom(p.color));
  const hq = $('bgHq');
  hq.alt = p.alt || '';
  $('bgLq').src = photoUrl(p, 40);
  if (ready) {
    hq.src = photoUrl(p, screenW());
    hq.classList.add('on');
  } else {
    hq.classList.remove('on');
    const img = new Image();
    img.onload = () => {
      hq.src = img.src;
      requestAnimationFrame(() => hq.classList.add('on'));
    };
    img.src = photoUrl(p, screenW());
  }
  const who = p.credit.name === 'Unsplash' ? '' : `Photo by <a href="${esc(p.credit.link)}">${esc(p.credit.name)}</a> on `;
  $('credit').innerHTML = `${who}<a href="https://unsplash.com/?utm_source=portal&utm_medium=referral">Unsplash</a>`;
  const fav = S?.favs.some((f) => f.id === p.id);
  $('favPhoto').classList.toggle('on', Boolean(fav));
  $('favPhoto').setAttribute('aria-pressed', String(Boolean(fav)));
}

/** Fetch the photo for the *next* load now and warm the browser cache, so the next page load is instant. */
async function prepareNext() {
  try {
    upcoming = await api(`api/photo?last=${encodeURIComponent(current?.id || '')}`);
    new Image().src = photoUrl(upcoming, screenW());
    stash('nextPhoto', upcoming);
  } catch {}
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let swapping = false;
/** Fade the current photo out, swap once the next one is loaded, fade back in (~.2s each way). */
async function nextPhoto() {
  if (swapping) return;
  swapping = true;
  try {
    let p = upcoming;
    upcoming = null;
    if (!p) {
      try { p = await api(`api/photo?last=${encodeURIComponent(current?.id || '')}`); } catch { return; }
    }
    const img = new Image();
    img.src = photoUrl(p, screenW());
    const loaded = img.decode().then(() => true, () => false);
    $('bgPhoto').classList.add('out');
    // If the image is slow (nothing prefetched), stop waiting and let it blur up as before.
    const [ready] = await Promise.all([Promise.race([loaded, wait(2500).then(() => false)]), wait(200)]);
    showPhoto(p, ready);
    $('bgPhoto').classList.remove('out');
  } finally {
    swapping = false;
  }
  prepareNext();
}
async function bootPhoto() {
  const ready = cached('nextPhoto');
  if (ready) showPhoto(ready);
  else {
    try { showPhoto(await api('api/photo')); } catch {}
  }
  prepareNext();
}
$('nextPhoto').onclick = nextPhoto;
$('favPhoto').onclick = () => {
  if (!current || !S) return;
  const on = S.favs.some((f) => f.id === current.id);
  const { kw, ...photo } = current;
  change(on ? 'Removed from favorites' : 'Saved to favorites', (s) => {
    s.favs = on ? s.favs.filter((f) => f.id !== current.id) : [...s.favs, photo];
  });
  $('favPhoto').classList.toggle('on', !on);
};
$('banPhoto').onclick = () => {
  if (!current || !S) return;
  const id = current.id;
  change('Photo hidden for good', (s) => {
    s.banned = [...s.banned, id];
    s.favs = s.favs.filter((f) => f.id !== id);
  });
  nextPhoto();
};

/* ================= clock ================= */
function tick() {
  const d = new Date();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  $('clock').innerHTML = `${h}:${m}<span class="ampm">${ap}</span>`;
  const g = d.getHours() < 12 ? 'Good morning' : d.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  $('dateline').innerHTML = `<strong>${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</strong> · ${g}`;
}

/* ================= keywords ================= */
function keywordEditor() {
  return S.keywords.map((k, i) => `<span class="kw-tog ${k.on ? 'on' : ''}"><button data-tog="${i}" aria-pressed="${k.on}">#${esc(k.name)}</button><button class="x" data-del="${i}" aria-label="Remove ${esc(k.name)}">×</button></span>`).join('')
    || '<span class="note" style="margin:0">No keywords. Add one.</span>';
}
function kwHandlers(container) {
  container.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tog]');
    const d = e.target.closest('[data-del]');
    if (t) { const i = +t.dataset.tog, k = S.keywords[i]; change(`#${k.name} ${k.on ? 'paused' : 'on'}`, (s) => (s.keywords[i].on = !k.on), refreshPhotoQueue); }
    if (d) { const i = +d.dataset.del, k = S.keywords[i]; change(`Removed #${k.name}`, (s) => s.keywords.splice(i, 1), refreshPhotoQueue); }
  });
}
function addKeyword(v) {
  v = v.trim().toLowerCase();
  if (!v || S.keywords.some((k) => k.name === v)) return;
  change(`Added #${v}`, (s) => s.keywords.push({ name: v, on: true }), refreshPhotoQueue);
}
/** After a keyword change, the photo queued for the next load may be from an old keyword. */
function refreshPhotoQueue() { upcoming = null; prepareNext(); }

/* ================= dock ================= */
let filterText = '';
let statuses = cached('status') || {};
const monogram = (n) => n.slice(0, 1).toUpperCase();
const STATUS_TEXT = { ok: 'Up', slow: 'Slow to respond', down: 'Not responding' };

const dockVisible = () => S?.showLinks !== false && !local.focus; // settings saved before showLinks existed lack it
function renderDock() {
  if (!S) return -1;
  $('dock').hidden = !dockVisible();
  const q = filterText.toLowerCase();
  let firstMatch = -1;
  const tiles = S.links.map((l, i) => {
    const hit = !q || l.name.toLowerCase().includes(q);
    if (hit && firstMatch < 0 && q) firstMatch = i;
    const st = statuses[l.url];
    const dot = st ? `<i class="dot ${st === 'slow' ? 'warn' : st === 'down' ? 'down' : ''}" title="${STATUS_TEXT[st]}"></i>` : '';
    return `<a class="tile ${q && !hit ? 'dim' : ''} ${i === firstMatch ? 'match-first' : ''}" href="${esc(l.url)}">
      <span class="mono">${esc(monogram(l.name))}${dot}</span>
      <span class="name">${esc(l.name)}</span>${i < 9 ? `<span class="key">${i + 1}</span>` : ''}</a>`;
  }).join('');
  $('dock').innerHTML = (q ? `<span class="filter">${esc(filterText)}</span>` : '') + tiles;
  return firstMatch;
}
function openLink(i, newTab) {
  const l = S?.links[i];
  if (!l) return;
  if (newTab) window.open(l.url, '_blank', 'noopener');
  else location.href = l.url;
}

/* ================= shared card bits ================= */
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const skeleton = (rows) => Array.from({ length: rows }, () => '<div style="display:grid;gap:7px;padding:8px 0"><div class="skel" style="width:60%"></div><div class="skel" style="width:35%"></div></div>').join('');
const moduleFailed = {};
const staleNote = (key) => (moduleFailed[key] && cache[key] ? ` · as of ${fmtTime(cache[key].at)}` : '');

/* ================= scores ================= */
function side(s, lose) {
  if (!s) return '';
  return `<div class="side ${lose ? 'lose' : ''}"><i class="bar" style="background:${esc(s.color)}"></i><span class="tname">${esc(s.name || s.abbr)}</span>${s.score != null ? `<span class="score">${s.score}</span>` : ''}</div>`;
}
function whenText(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
  const t = fmtTime(ms);
  if (days === 0) return `Today ${t}`;
  if (days === 1) return `Tomorrow ${t}`;
  if (days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${t}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function gameRow(g) {
  const team = g.team;
  if (!g.event) {
    return `<div class="game quiet"><div class="matchup">${side({ name: team.name, color: team.color })}</div><div class="status">No games scheduled</div></div>`;
  }
  const e = g.event;
  const us = e.sides.find((s) => s.id === team.id) || e.sides[0];
  const them = e.sides.find((s) => s !== us);
  const sub = [e.tv, e.note].filter(Boolean).map(esc).join(' · ');
  let matchup, status;
  if (g.state === 'today' || g.state === 'next') {
    matchup = side(us) + side(them && { ...them, name: `${us.home ? 'vs' : '@'} ${them.name || them.abbr}` });
    status = `<span class="tag">${g.league}</span> <span class="big">${whenText(e.date)}</span>${sub}`;
  } else {
    const won = g.state === 'final' && (us.winner ?? (us.score ?? 0) > (them?.score ?? 0));
    const tie = g.state === 'final' && us.score === them?.score;
    matchup = side(us, g.state === 'final' && !won && !tie) + side(them, g.state === 'final' && won);
    status = g.state === 'live'
      ? `<span class="tag">${g.league}</span> <span class="tag livetag">LIVE</span> <span class="big">${esc(e.detail)}</span>${sub}`
      : `<span class="tag">${g.league}</span> ${tie ? '' : `<span class="wl ${won ? 'w' : 'l'}">${won ? 'W' : 'L'}</span>`}<span class="big">${esc(e.detail || 'Final')}</span>${sub}`;
  }
  return `<a class="game" href="${esc(e.link)}" target="_blank" rel="noopener"><div class="matchup">${matchup}</div><div class="status">${status}</div></a>`;
}
function scoresCard() {
  const data = cached('scores');
  if (!data) return `<article class="card"><div class="card-h"><h2>Scores</h2></div>${moduleFailed.scores ? '<p class="empty">Scores are unavailable right now.</p>' : skeleton(3)}</article>`;
  const rows = data.games;
  const html = rows.map(gameRow).join('') || '<p class="empty">You aren\'t following any teams. Add some in Settings → Sports.</p>';
  const live = rows.filter((r) => r.state === 'live').length;
  return `<article class="card ${moduleFailed.scores ? 'stale' : ''}"><div class="card-h"><h2>Scores</h2><span class="meta">${live ? `${live} live · ` : ''}${rows.length} teams${staleNote('scores')}</span></div><div class="games scroll">${html}</div></article>`;
}

/* ================= stocks ================= */
function sparkline(points, base, up, x0, x1) {
  const W = 96, H = 34;
  if (points.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
  const vals = [...points.map((p) => p.v), base];
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (t) => ((t - x0) / (x1 - x0 || 1)) * W;
  const y = (v) => H - 3 - ((v - lo) / span) * (H - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const c = up ? '#5fe0a0' : '#ff8a80';
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  const last = points[points.length - 1], lx = x(last.t).toFixed(1), ly = y(last.v).toFixed(1);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".35"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}" stroke="rgba(255,255,255,.28)" stroke-dasharray="2 3" stroke-width="1"/>
    <path d="${d}L${lx},${H}L${x(points[0].t).toFixed(1)},${H}Z" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.6" fill="${c}"/></svg>`;
}
const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function quoteRow(q) {
  if (q.error) return `<div class="quote"><div style="min-width:0"><span class="sym">${esc(q.symbol)}</span><span class="sub">${esc(q.error)}</span></div><span></span><span class="unavail">Unavailable</span></div>`;
  const up = q.change >= 0;
  let spark, sub;
  if (q.kind === 'fund') {
    const s = q.series;
    const base = s[0]?.v ?? q.prevClose;
    spark = sparkline(s, base, (s.at(-1)?.v ?? q.price) >= base, s[0]?.t ?? 0, s.at(-1)?.t ?? 1);
    sub = `NAV · ${new Date(q.asOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · 30 days`;
  } else {
    const x0 = q.session?.start ?? q.series[0]?.t ?? 0;
    const x1 = q.session?.end ?? q.series.at(-1)?.t ?? 1;
    // Before the open the series is yesterday's session; show it against its own bounds.
    const s = q.series.filter((p) => p.t >= x0 && p.t <= x1);
    spark = s.length > 1 ? sparkline(s, q.prevClose, up, x0, x1) : sparkline(q.series, q.prevClose, up, q.series[0]?.t ?? 0, q.series.at(-1)?.t ?? 1);
    sub = esc(q.kind === 'index' ? `${q.name} · index` : q.name);
  }
  const sign = up ? '+' : '−';
  return `<a class="quote" href="https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}" target="_blank" rel="noopener">
    <div style="min-width:0"><span class="sym">${esc(q.label || q.symbol)}</span><span class="sub">${sub}</span></div>${spark}
    <div class="px">${money(q.price)}<span class="chg ${up ? 'up' : 'down'}">${sign}${money(Math.abs(q.change))}<span class="chip ${up ? 'up' : 'down'}">${sign}${Math.abs(q.changePct).toFixed(2)}%</span></span></div></a>`;
}
function stocksCard() {
  const data = cached('quotes');
  if (!data) return `<article class="card"><div class="card-h"><h2>Stocks</h2></div>${moduleFailed.quotes ? '<p class="empty">Quotes are unavailable right now.</p>' : skeleton(3)}</article>`;
  const rows = data.quotes.map(quoteRow).join('') || '<p class="empty">Your watchlist is empty. Add symbols in Settings → Stocks.</p>';
  const lead = data.quotes.find((q) => q.kind === 'equity' || q.kind === 'index');
  let meta = '';
  if (lead) {
    if (lead.market === 'open') meta = `<span class="live-dot"></span>Open · updated ${fmtTime(cache.quotes.at)}`;
    else if (lead.market === 'pre') meta = 'Pre-market';
    else meta = `Closed · as of ${lead.session ? fmtTime(lead.session.end) : fmtTime(lead.asOf)}`;
  }
  const closed = !lead || lead.market !== 'open';
  return `<article class="card ${closed || moduleFailed.quotes ? 'stale' : ''}"><div class="card-h"><h2>Stocks</h2><span class="meta">${meta}${staleNote('quotes')}</span></div><div class="quotes scroll">${rows}</div></article>`;
}

/* ================= camera ================= */
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const text = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return date.toDateString() === yest.toDateString() ? `Yesterday · ${text}` : text;
}
function cameraCard() {
  const cam = cached('camera');
  const label = esc(S?.camera.label || 'Camera');
  if (!cam || cam.none) {
    const msg = cam?.processing ? 'Converting the latest daily summary. This takes a few minutes.'
      : cam?.error ? esc(cam.error)
      : 'No daily summary yet. It shows up here the morning after the camera script runs.';
    return `<article class="card"><div class="card-h"><h2>Camera</h2><span class="meta">${label} · daily summary</span></div><div class="poster none">${cam || moduleFailed.camera ? msg : '<div class="skel" style="width:60%"></div>'}</div></article>`;
  }
  return `<article class="card"><div class="card-h"><h2>Camera</h2><span class="meta">${label} · daily summary</span></div>
    <button class="poster" data-play aria-label="Play the daily summary for ${esc(dayLabel(cam.date))}"><img src="${esc(cam.poster)}" alt="${label} camera, ${esc(dayLabel(cam.date))}"><span class="play"><span><svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span></span><span class="dur tnum">${fmtDur(cam.duration)}</span></button>
    <div class="cam-meta"><span>${esc(dayLabel(cam.date))}</span><span>${cam.processing ? 'Converting a newer summary…' : 'Replaced each morning'}</span></div></article>`;
}

/* ================= cards ================= */
function renderCards() {
  if (!S) { $('cards').innerHTML = scoresCard() + stocksCard() + cameraCard(); return; }
  const make = { scores: scoresCard, stocks: stocksCard, camera: cameraCard };
  $('cards').innerHTML = S.cards.filter((c) => c.on).map((c) => make[c.id]()).join('');
  $('cards').classList.toggle('hide', local.focus);
}
$('cards').addEventListener('click', (e) => {
  if (e.target.closest('[data-play]')) openTheater();
});

/* ================= theater ================= */
function openTheater() {
  const cam = cached('camera');
  if (!cam || cam.none) return;
  $('theater').hidden = false;
  $('theaterTitle').textContent = `${S?.camera.label || 'Camera'} · ${dayLabel(cam.date)}`;
  const v = $('video');
  if (!v.src.endsWith(cam.video)) { v.src = cam.video; v.poster = cam.poster; }
  v.playbackRate = +document.querySelector('#speed [aria-pressed="true"]').dataset.r;
  v.play().catch(() => {});
  $('clipLabel').textContent = `Daily summary · ${fmtDur(cam.duration)}`;
  $('closeTheater').focus();
}
$('speed').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  [...$('speed').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('video').playbackRate = +b.dataset.r;
});
function closeTheater() { $('video').pause(); $('theater').hidden = true; }
$('closeTheater').onclick = closeTheater;
$('theater').addEventListener('click', (e) => { if (e.target === $('theater')) closeTheater(); });

/* ================= weather ================= */
const WX = (c) => c === 0 ? ['Clear', 'sun'] : c <= 2 ? ['Partly cloudy', 'part'] : c === 3 ? ['Overcast', 'cloud']
  : c <= 48 ? ['Fog', 'fog'] : c <= 57 ? ['Drizzle', 'rain'] : c <= 67 ? ['Rain', 'rain'] : c <= 77 ? ['Snow', 'snow']
  : c <= 82 ? ['Showers', 'rain'] : c <= 86 ? ['Snow showers', 'snow'] : ['Thunderstorms', 'storm'];
function wxIcon(code, day = 1) {
  const k = WX(code)[1], sun = '#ffd36b', cl = '#f2f4f7', rn = '#9dd6ff';
  const cloud = (dx = 0, dy = 0, f = cl) => `<path transform="translate(${dx} ${dy})" d="M9 21h12a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 10 12a4.5 4.5 0 0 0-1 9z" fill="${f}"/>`;
  const orb = (cx, cy, r) => day
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${sun}"/><g stroke="${sun}" stroke-width="1.6" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => { const t = (a * Math.PI) / 180; return `<line x1="${(cx + Math.cos(t) * (r + 2.5)).toFixed(2)}" y1="${(cy + Math.sin(t) * (r + 2.5)).toFixed(2)}" x2="${(cx + Math.cos(t) * (r + 4.5)).toFixed(2)}" y2="${(cy + Math.sin(t) * (r + 4.5)).toFixed(2)}"/>`; }).join('')}</g>`
    : `<path d="M${cx + 2} ${cy - r}a${r} ${r} 0 1 0 ${r - 1} ${r + 4}a${r - 1} ${r - 1} 0 0 1 -${r - 1} -${r + 4}z" fill="#e8e2c8"/>`;
  const drops = `<g stroke="${rn}" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="23" x2="10.5" y2="27"/><line x1="17" y1="23" x2="15.5" y2="27"/><line x1="22" y1="23" x2="20.5" y2="27"/></g>`;
  const body = {
    sun: orb(16, 16, 6.5),
    part: orb(12, 11, 5) + cloud(2, 4),
    cloud: cloud(-3, -2, '#b9c0ca') + cloud(2, 3),
    fog: `<g stroke="${cl}" stroke-width="2" stroke-linecap="round"><line x1="6" y1="12" x2="26" y2="12"/><line x1="4" y1="17" x2="24" y2="17"/><line x1="8" y1="22" x2="28" y2="22"/></g>`,
    rain: cloud(0, -2) + drops,
    snow: cloud(0, -2) + `<g fill="${cl}"><circle cx="11" cy="25" r="1.4"/><circle cx="16.5" cy="27" r="1.4"/><circle cx="22" cy="25" r="1.4"/></g>`,
    storm: cloud(0, -2) + `<path d="M17 21l-4 5h4l-2 4 6-6h-4l2-3z" fill="${sun}"/>`,
  }[k];
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
}
function renderWeather() {
  const el = $('wx');
  const w = cached('weather');
  if (!w || !S || w.key !== wxKey()) { el.innerHTML = ''; return; }
  const { current: c, daily: d, hourly: h } = w;
  const now = Date.now();
  let start = h.time.findIndex((t) => new Date(t).getTime() > now);
  if (start < 0) start = 0;
  const hours = [];
  for (let i = start; hours.length < 6 && i < h.time.length; i += 2) hours.push(i);
  const fmtH = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric' });
  const rain = d.precipitation_probability_max[0];
  el.classList.remove('loading');
  el.innerHTML = `<div class="wx-now" title="${esc(S.weather.name)}">${wxIcon(c.weather_code, c.is_day)}<span class="wx-temp">${Math.round(c.temperature_2m)}°</span>
      <span class="wx-desc"><strong>${WX(c.weather_code)[0]}</strong>H ${Math.round(d.temperature_2m_max[0])}° · L ${Math.round(d.temperature_2m_min[0])}°${rain >= 20 ? ` · ${rain}% rain` : ''}</span></div>
    ${S.weather.hourly ? `<div class="wx-hours">${hours.map((i) => `<div class="wx-h"><span>${fmtH(h.time[i])}</span>${wxIcon(h.weather_code[i], h.is_day[i])}<b>${Math.round(h.temperature_2m[i])}°</b><span class="pp">${h.precipitation_probability[i] >= 20 ? `${h.precipitation_probability[i]}%` : ''}</span></div>`).join('')}</div>` : ''}`;
}
const wxKey = () => `${S.weather.lat},${S.weather.lon},${S.weather.unit}`;
async function loadWeather(force = false) {
  if (!S) return;
  const w = cache.weather;
  if (!force && w && w.value.key === wxKey() && Date.now() - w.at < 15 * 60e3) return;
  if (force) $('wx').classList.add('loading');
  const { lat, lon, unit } = S.weather;
  try {
    // Open-Meteo is called straight from the browser: free, no key, and it allows CORS.
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,precipitation_probability,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2&timezone=auto${unit === 'F' ? '&temperature_unit=fahrenheit' : ''}`);
    if (!r.ok) throw new Error(r.status);
    stash('weather', { ...(await r.json()), key: wxKey() });
  } catch {
    $('wx').classList.remove('loading');
    return;
  }
  renderWeather();
}

/* ================= data refresh ================= */
let lastRun = {};
async function load(key, path) {
  try {
    stash(key, await api(path));
    moduleFailed[key] = false;
  } catch {
    moduleFailed[key] = true;
  }
}
async function refreshScores() { await load('scores', 'api/scores'); renderCards(); }
async function refreshQuotes() { await load('quotes', 'api/quotes'); renderCards(); }
async function refreshCamera() { await load('camera', 'api/camera'); renderCards(); }
async function refreshStatus() {
  try { statuses = await api('api/status'); stash('status', statuses); } catch {}
  renderDock();
}
function refreshAll() {
  refreshScores(); refreshQuotes(); refreshCamera(); refreshStatus(); loadWeather();
  const now = Date.now();
  lastRun = { scores: now, quotes: now, status: now, camera: now, weather: now };
}

// Poll only while the page is visible. Scores speed up while a game is live.
function every(name, ms, fn) {
  if (document.hidden) return;
  if (Date.now() - (lastRun[name] || 0) >= ms()) { lastRun[name] = Date.now(); fn(); }
}
setInterval(() => {
  every('scores', () => (cached('scores')?.games.some((g) => g.state === 'live') ? 30e3 : 120e3), refreshScores);
  every('quotes', () => 60e3, refreshQuotes);
  every('status', () => 60e3, refreshStatus);
  every('camera', () => 10 * 60e3, refreshCamera);
  every('weather', () => 5 * 60e3, () => loadWeather());
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { lastRun = {}; }
});

/* ================= settings drawer ================= */
const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};
const TABS = ['Background', 'Weather', 'Links', 'Sports', 'Stocks', 'Camera', 'Layout'];
const LEAGUES = ['NFL', 'NBA', 'NCAAB', 'MLB'];
// Mirrors INDEX_LABELS in src/quotes.ts.
const INDEXES = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq' },
  { symbol: '^DJI', label: 'Dow' },
  { symbol: '^RUT', label: 'Russell 2000' },
  { symbol: '^VIX', label: 'VIX' },
];
let tab = 'Background';
let sportsLeague = 'NFL';
let teamQuery = '';
const teamLists = {};

function moveBtns(kind, i, len) {
  return `<button class="mini" data-act="up" data-kind="${kind}" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ICON.up}</button>
          <button class="mini" data-act="down" data-kind="${kind}" data-i="${i}" ${i === len - 1 ? 'disabled' : ''} aria-label="Move down">${ICON.down}</button>`;
}
const noteRow = (text) => `<div class="li"><span class="grow note" style="margin:0">${text}</span></div>`;
function teamName(t) {
  const list = teamLists[t.league];
  return list?.find((x) => x.id === t.id) || cached('scores')?.games.find((g) => g.league === t.league && g.team.id === t.id)?.team;
}

function renderSettings() {
  if (!S) return;
  $('tabs').innerHTML = TABS.map((t) => `<button role="tab" aria-selected="${t === tab}" data-tab="${t}">${t}</button>`).join('');
  const P = $('tabpanel');

  if (tab === 'Background') {
    P.innerHTML = `<section><h3>Keywords</h3><div class="kw-edit" id="kwDrawerList">${keywordEditor()}</div>
      <form class="addrow" id="kwDrawerAdd"><input id="kwDrawerInput" placeholder="Add a keyword, e.g. mountains" aria-label="Add a keyword"><button class="btn">Add</button></form>
      <p class="note">Each load picks one active keyword at random. Tap a keyword to pause it.</p></section>
      <section><h3>Favorites</h3><div class="row"><span>${S.favs.length} saved · mix them back in</span>
        <div class="seg" id="favMix">${[[0, 'Never'], [0.1, '1 in 10'], [0.25, '1 in 4']].map(([v, l]) => `<button data-v="${v}" aria-pressed="${S.favMix === v}">${l}</button>`).join('')}</div></div></section>
      <section><h3>Hidden photos</h3>${S.banned.length
        ? `<div class="row"><span>${S.banned.length} photo${S.banned.length === 1 ? '' : 's'} will never show again</span><button class="btn" id="unbanAll">Show them again</button></div>`
        : '<p class="note" style="margin:0">None. Use ⊘ on a photo you never want to see again.</p>'}</section>`;
    kwHandlers($('kwDrawerList'));
    $('kwDrawerAdd').onsubmit = (e) => { e.preventDefault(); addKeyword($('kwDrawerInput').value); setTimeout(() => $('kwDrawerInput')?.focus()); };
    $('favMix').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) change('Favorites mix updated', (s) => (s.favMix = +b.dataset.v)); };
    $('unbanAll')?.addEventListener('click', () => change('Hidden photos back in rotation', (s) => (s.banned = [])));
  }

  if (tab === 'Weather') {
    P.innerHTML = `<section><h3>Location</h3><div class="row"><span>${esc(S.weather.name)}</span></div>
      <form class="addrow" id="wxFind"><input id="wxQuery" placeholder="Search a city or town" aria-label="Search a city or town"><button class="btn">Search</button></form>
      <div class="list" id="wxResults" style="margin-top:8px" hidden></div></section>
      <section><div class="row"><span>Units</span><div class="seg" id="wxUnit">${['F', 'C'].map((u) => `<button data-u="${u}" aria-pressed="${S.weather.unit === u}">°${u}</button>`).join('')}</div></div></section>
      <section><div class="row"><span>Show the next 12 hours</span><input type="checkbox" class="switch" id="wxHourSw" ${S.weather.hourly ? 'checked' : ''}></div>
      <p class="note">Forecast from Open-Meteo, the same source as the Weather app.</p></section>`;
    $('wxFind').onsubmit = async (e) => {
      e.preventDefault();
      const q = $('wxQuery').value.trim();
      if (!q) return;
      const box = $('wxResults');
      box.hidden = false;
      box.innerHTML = noteRow('Searching…');
      try {
        const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`)).json();
        box.innerHTML = (r.results || []).map((g, i) => `<button class="li" style="background:none;border-left:0;border-right:0;border-bottom:0;text-align:left;width:100%" data-g="${i}"><span class="grow">${esc(g.name)}<small>${esc([g.admin1, g.country].filter(Boolean).join(', '))}</small></span></button>`).join('')
          || noteRow('No places match that name.');
        box.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => {
          const g = r.results[+b.dataset.g];
          change(`Weather set to ${g.name}`, (s) => Object.assign(s.weather, { name: [g.name, g.admin1].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude }));
          loadWeather(true);
        }));
      } catch {
        box.innerHTML = noteRow('Search is unavailable right now. Try again in a minute.');
      }
    };
    $('wxUnit').onclick = (e) => {
      const b = e.target.closest('[data-u]');
      if (b && b.dataset.u !== S.weather.unit) { change(`Showing °${b.dataset.u}`, (s) => (s.weather.unit = b.dataset.u)); loadWeather(true); }
    };
    $('wxHourSw').onchange = (e) => { change(e.target.checked ? 'Hourly forecast on' : 'Hourly forecast off', (s) => (s.weather.hourly = e.target.checked)); renderWeather(); };
  }

  if (tab === 'Links') {
    P.innerHTML = `<section><h3>Sites · order sets the 1–9 keys</h3><div class="list">${S.links.map((l, i) => `<div class="li"><span class="mono" style="flex:none">${esc(monogram(l.name))}</span>
        <span class="grow">${esc(l.name)}<small>${esc(l.url)}</small></span>${moveBtns('links', i, S.links.length)}
        <button class="mini" data-act="del" data-kind="links" data-i="${i}" aria-label="Remove ${esc(l.name)}">${ICON.x}</button></div>`).join('') || noteRow('No sites yet.')}</div></section>
      <section><h3>Add a site</h3><form id="linkAdd" style="display:grid;gap:8px"><input class="field" id="linkName" placeholder="Name" required maxlength="40"><input class="field" id="linkUrl" placeholder="https://" required type="url"><button class="btn primary" style="justify-self:start">Add site</button></form>
      <p class="note">Status dots show whether each site answered in the last minute.</p></section>`;
    $('linkAdd').onsubmit = (e) => {
      e.preventDefault();
      const name = $('linkName').value.trim(), url = $('linkUrl').value.trim();
      change(`Added ${name}`, (s) => s.links.push({ name, url }), refreshStatus);
    };
  }

  if (tab === 'Sports') {
    const list = teamLists[sportsLeague];
    const q = teamQuery.toLowerCase();
    const following = S.teams.map((t, i) => {
      const info = teamName(t);
      return `<div class="li"><i class="teamdot" style="background:${esc(info?.color || '#9aa3ad')}"></i><span class="grow">${esc(info?.name || `Team ${t.id}`)}<small>${t.league}</small></span>
        <button class="mini" data-act="del" data-kind="teams" data-i="${i}" aria-label="Unfollow ${esc(info?.name || '')}">${ICON.x}</button></div>`;
    }).join('');
    const pool = list ? list.filter((t) => !S.teams.some((f) => f.league === sportsLeague && f.id === t.id) && t.name.toLowerCase().includes(q)).slice(0, 40) : null;
    P.innerHTML = `<section><h3>Following</h3><div class="list">${following || noteRow('Not following anyone yet.')}</div></section>
      <section><h3>Add teams</h3><div class="seg" id="leagues" style="margin-bottom:10px">${LEAGUES.map((l) => `<button data-l="${l}" aria-pressed="${l === sportsLeague}">${l}</button>`).join('')}</div>
        <input class="field" id="teamSearch" placeholder="Search ${sportsLeague} teams" value="${esc(teamQuery)}" style="width:100%;margin-bottom:8px" aria-label="Search teams">
        <div class="list">${pool == null ? noteRow('Loading teams…')
          : pool.map((t) => `<div class="li"><i class="teamdot" style="background:${esc(t.color)}"></i><span class="grow">${esc(t.name)}</span><button class="mini" data-follow="${t.id}" aria-label="Follow ${esc(t.name)}">${ICON.plus}</button></div>`).join('') || noteRow('No teams match.')}</div>
        <p class="note">Order is automatic: live games, then later today, then finals from the last day, then next scheduled.</p></section>`;
    $('leagues').onclick = (e) => { const b = e.target.closest('[data-l]'); if (b) { sportsLeague = b.dataset.l; teamQuery = ''; renderSettings(); } };
    $('teamSearch').oninput = (e) => {
      teamQuery = e.target.value;
      renderSettings();
      const el = $('teamSearch');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };
    P.querySelectorAll('[data-follow]').forEach((b) => (b.onclick = () => {
      const t = teamLists[sportsLeague].find((x) => x.id === b.dataset.follow);
      change(`Following ${t.name}`, (s) => s.teams.push({ league: sportsLeague, id: t.id }), refreshScores);
    }));
    if (!list) {
      api(`api/sports/teams?league=${sportsLeague}`)
        .then((r) => { teamLists[sportsLeague] = r.teams; if (tab === 'Sports') renderSettings(); })
        .catch(() => { if (tab === 'Sports') P.querySelector('.list:last-of-type').innerHTML = noteRow('ESPN is unavailable right now. Try again in a minute.'); });
    }
  }

  if (tab === 'Stocks') {
    const names = Object.fromEntries((cached('quotes')?.quotes || []).filter((q) => q.name).map((q) => [q.symbol, q]));
    const idxOff = INDEXES.filter((x) => !S.tickers.includes(x.symbol));
    P.innerHTML = `<section><h3>Watchlist</h3><div class="list">${S.tickers.map((s, i) => `<div class="li"><span class="grow"><b style="font:600 16px var(--f-display);letter-spacing:.05em">${esc(INDEXES.find((x) => x.symbol === s)?.label || s)}</b><small>${names[s] ? esc(names[s].kind === 'fund' ? `${names[s].name} · daily NAV` : names[s].name) : ''}</small></span>
        ${moveBtns('tickers', i, S.tickers.length)}<button class="mini" data-act="del" data-kind="tickers" data-i="${i}" aria-label="Remove ${esc(s)}">${ICON.x}</button></div>`).join('') || noteRow('No symbols yet.')}</div>
      <form class="addrow" id="tickAdd"><input id="tickInput" placeholder="Symbol, e.g. MSFT or SPX" aria-label="Add a symbol" style="text-transform:uppercase"><button class="btn" id="tickBtn">Add</button></form>
      <p class="err" id="tickErr" hidden></p></section>
      <section><h3>Market indexes</h3>${idxOff.length
        ? `<div class="kw-edit" id="idxAdd">${idxOff.map((x) => `<button class="btn" data-sym="${esc(x.symbol)}" data-label="${esc(x.label)}">+ ${esc(x.label)}</button>`).join('')}</div>`
        : '<p class="note" style="margin:0">All of them are on your watchlist.</p>'}
      <p class="note">Or type SPX, Dow or Nasdaq in the box above.</p></section>`;
    $('tickAdd').onsubmit = async (e) => {
      e.preventDefault();
      const sym = $('tickInput').value.trim().toUpperCase();
      if (!sym) return;
      $('tickBtn').disabled = true;
      try {
        const q = await api(`api/quotes/lookup?symbol=${encodeURIComponent(sym)}`);
        if (S.tickers.includes(q.symbol)) throw new Error(`${q.name} is already on your watchlist`);
        change(`Added ${q.symbol} · ${q.name}`, (s) => s.tickers.push(q.symbol), refreshQuotes);
      } catch (err) {
        $('tickErr').textContent = err.message;
        $('tickErr').hidden = false;
        $('tickBtn').disabled = false;
      }
    };
    $('idxAdd')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sym]');
      if (b) change(`Added ${b.dataset.label}`, (s) => s.tickers.push(b.dataset.sym), refreshQuotes);
    });
  }

  if (tab === 'Camera') {
    const cam = cached('camera');
    P.innerHTML = `<section><h3>Camera name</h3><form class="addrow" id="camForm"><input id="camLabel" value="${esc(S.camera.label)}" maxlength="40" aria-label="Camera name"><button class="btn">Save</button></form></section>
      <section><h3>What shows</h3><p class="note" style="margin:0">Always the newest daily summary from the SecurityCameras share. Portal keeps one converted copy and replaces it when the next day's summary lands. It never changes the original recordings.</p>
      ${cam?.error ? `<p class="err">${esc(cam.error)}</p>` : ''}</section>`;
    $('camForm').onsubmit = (e) => { e.preventDefault(); const v = $('camLabel').value.trim() || 'Camera'; change(`Camera renamed to ${v}`, (s) => (s.camera.label = v)); };
  }

  if (tab === 'Layout') {
    const label = { scores: 'Scores', stocks: 'Stocks', camera: 'Camera' };
    P.innerHTML = `<section><h3>Cards · left to right</h3><div class="list">${S.cards.map((c, i) => `<div class="li"><span class="grow">${label[c.id]}</span>${moveBtns('cards', i, S.cards.length)}
        <input type="checkbox" class="switch" data-card="${i}" ${c.on ? 'checked' : ''} aria-label="Show ${label[c.id]}"></div>`).join('')}</div></section>
      <section><div class="row"><span>Show the sites bar</span><input type="checkbox" class="switch" id="linksSw" ${S.showLinks !== false ? 'checked' : ''}></div></section>
      <section><div class="row"><span>Focus mode: photo, clock and weather only<br><small class="note">Shortcut: <kbd>.</kbd> · remembered on this browser</small></span><input type="checkbox" class="switch" id="focusSw" ${local.focus ? 'checked' : ''}></div></section>`;
    P.querySelectorAll('[data-card]').forEach((sw) => (sw.onchange = () => {
      const i = +sw.dataset.card;
      change(`${label[S.cards[i].id]} ${sw.checked ? 'shown' : 'hidden'}`, (s) => (s.cards[i].on = sw.checked));
    }));
    $('linksSw').onchange = (e) => change(e.target.checked ? 'Sites bar shown' : 'Sites bar hidden', (s) => (s.showLinks = e.target.checked));
    $('focusSw').onchange = (e) => setFocus(e.target.checked);
  }
}
$('tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderSettings(); } };
$('tabpanel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const kind = b.dataset.kind, i = +b.dataset.i;
  const after = { teams: refreshScores, tickers: refreshQuotes, links: refreshStatus }[kind];
  if (b.dataset.act === 'del') {
    const item = S[kind][i];
    const name = kind === 'teams' ? teamName(item)?.name || 'team' : item.name || item;
    change(`Removed ${name}`, (s) => s[kind].splice(i, 1), after);
  } else {
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    change('Order updated', (s) => ([s[kind][i], s[kind][j]] = [s[kind][j], s[kind][i]]), after);
  }
});
function openSettings() {
  if (!S) return;
  $('drawer').classList.add('open');
  renderSettings();
  setTimeout(() => $('tabs').querySelector('[aria-selected="true"]')?.focus(), 50);
}
function closeSettings() { $('drawer').classList.remove('open'); $('openSettings').focus(); }
$('openSettings').onclick = openSettings;
$('closeSettings').onclick = closeSettings;

function setFocus(on) {
  local.focus = on;
  saveLocal();
  renderDock();
  renderCards();
  if ($('drawer').classList.contains('open')) renderSettings();
}

/* ================= keyboard ================= */
document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea, select');
  if (e.key === 'Escape') {
    if (!$('keys').hidden) { $('keys').hidden = true; return; }
    if (!$('theater').hidden) return closeTheater();
    if ($('drawer').classList.contains('open')) return closeSettings();
    if (filterText) { filterText = ''; renderDock(); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('theater').hidden || $('drawer').classList.contains('open')) return;
  if (!$('keys').hidden) $('keys').hidden = true;
  if (/^[1-9]$/.test(e.key)) { e.preventDefault(); openLink(+e.key - 1, e.shiftKey); return; }
  if (e.key === '?') { e.preventDefault(); $('keys').hidden = false; return; }
  if (/^[a-z]$/i.test(e.key) && dockVisible()) { e.preventDefault(); filterText += e.key; renderDock(); return; }
  if (e.key === 'Backspace' && filterText) { e.preventDefault(); filterText = filterText.slice(0, -1); renderDock(); return; }
  if (e.key === 'Enter' && filterText) { e.preventDefault(); const i = renderDock(); if (i >= 0) openLink(i, e.shiftKey); return; }
  if (filterText) return;
  if (e.key === ' ' && !e.target.closest('button, a')) { e.preventDefault(); nextPhoto(); }
  if (e.key === '.') setFocus(!local.focus);
  if (e.key === ',') { e.preventDefault(); openSettings(); }
});
$('keys').onclick = () => ($('keys').hidden = true);

/* ================= boot ================= */
function renderAll() {
  renderDock();
  renderCards();
  renderWeather();
  if ($('drawer').classList.contains('open')) renderSettings();
}

tick();
setInterval(tick, 1000);
renderAll();
bootPhoto();
api('api/settings')
  .then((s) => { S = s; stash('settings', s); renderAll(); refreshAll(); })
  .catch(() => renderAll());
