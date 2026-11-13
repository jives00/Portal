/* The DevDash tab: every tracked app, bot and shared service (containers, health, errors, recent
 * logs), plus the MySQL backup. Portal reads Docker itself (/api/devdash); what's tracked is edited
 * here (Add / Edit / Remove). "Logs" opens a live log viewer over the page.
 * Paints from localStorage first, then polls every 10 s while the tab is showing. */

const KEY = 'portal-devdash-v2';
const STALE_BACKUP_MS = 26 * 3600e3; // the backup runs daily at 1 am
const KIND_LABEL = { app: 'Application', bot: 'Bot', infra: 'Infrastructure' };

const D = {
  api: null, esc: null, data: null, at: 0, error: null, timer: null,
  open: new Set(), confirm: null, html: '',
  form: null, // { original: name | null, oneShot: [] } while the add/edit form is showing
  logs: null, // { name, since, es, lines, paused, filter } while the log viewer is open
};
try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c) { D.data = c.data; D.at = c.at; } } catch {}

const $ = (id) => document.getElementById(id);

function ago(t) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const BADGES = { running: ['ok', 'Running'], stopped: ['down', 'Stopped'], restarting: ['warn', 'Restarting'], missing: ['down', 'Missing'], unknown: ['', 'Unknown'] };
function badge(status, label) {
  const [cls, text] = BADGES[status] || BADGES.unknown;
  return `<span class="dd-badge ${cls}"><i></i>${label ?? text}</span>`;
}
// No info means Docker couldn't be read (unknown) or the container doesn't exist (missing).
const statusOf = (c) => c.info?.status ?? (D.data?.docker ? 'unknown' : 'missing');
const logsBtn = (name) => `<button class="dd-link" data-logs="${D.esc(name)}">Logs</button>`;

function actions(s) {
  const e = D.esc;
  if (D.confirm === s.name) {
    return `<span class="dd-confirm">Stop tracking ${e(s.name)}?
      <button class="dd-link danger" data-remove="${e(s.name)}">Remove</button>
      <button class="dd-link" data-cancel>Cancel</button></span>`;
  }
  return `<button class="dd-link" data-edit="${e(s.name)}">Edit</button>
    <button class="dd-link" data-ask="${e(s.name)}">Remove</button>`;
}

function serviceCard(s) {
  const e = D.esc;
  const cs = s.containers || [];
  const errors = cs.reduce((n, c) => n + (c.errorCount || 0), 0);
  const statuses = cs.map(statusOf);
  const overall = statuses.includes('restarting') ? 'restarting'
    : statuses.length && statuses.every((x) => x === 'running') ? 'running'
    : statuses.includes('unknown') ? 'unknown' : 'stopped';
  const h = s.health;
  const open = D.open.has(s.name);
  const lastError = errors > 0 ? cs.map((c) => c.lastError).find(Boolean) : null;
  const lastMsg = !s.healthUrl ? cs.map((c) => c.lastMessage).find(Boolean) : null;
  const preview = cs[0]?.logPreview || [];

  return `<article class="card dd-card${overall === 'stopped' || overall === 'restarting' ? ' bad' : ''}">
    <div class="dd-head">
      ${badge(overall)}
      <h2>${e(s.name)}</h2>
      ${errors ? `<span class="dd-errs">${errors} error${errors === 1 ? '' : 's'}</span>` : ''}
      <span class="sp"></span>
      ${s.webUrl ? `<a class="dd-link" href="${e(s.webUrl)}" target="_blank" rel="noopener">Open →</a>` : ''}
    </div>
    ${h ? `<div class="dd-health ${h.ok ? 'ok' : 'down'}">
      <b>${h.ok ? '✓ Healthy' : '✗ Unhealthy'}</b>
      ${h.latencyMs > 0 ? `<span>${h.latencyMs}ms</span>` : ''}
      ${h.db ? `<span>DB: ${e(h.db)}</span>` : ''}
      ${h.error ? `<span class="dd-err">${e(h.error)}</span>` : ''}
    </div>` : ''}
    <ul class="dd-rows">${cs.map((c) => `<li>
      ${badge(statusOf(c))}
      <code>${e(c.name)}</code>
      <span class="sp"></span>
      ${c.info?.uptime ? `<span class="dim">up ${e(c.info.uptime)}</span>` : ''}
      ${c.info?.restartCount > 0 ? `<span class="warn">${c.info.restartCount} restart${c.info.restartCount === 1 ? '' : 's'}</span>` : ''}
      ${c.info ? logsBtn(c.name) : ''}
    </li>`).join('')}</ul>
    ${(s.oneShot || []).map((o) => `<div class="dd-oneshot"><span>${e(o.name)}:</span>${o.finishedAt
      ? `<span class="${o.exitCode === 0 ? 'ok' : 'down'}">${o.exitCode === 0 ? 'OK' : `exit ${e(o.exitCode)}`}</span><span class="dim">${ago(o.finishedAt)}</span>${logsBtn(o.container)}`
      : '<span class="dim">never run</span>'}</div>`).join('')}
    ${lastError ? `<pre class="dd-lasterr">${e(lastError)}</pre>` : ''}
    <div class="dd-foot">
      <button class="dd-toggle" data-toggle="${e(s.name)}" aria-expanded="${open}">${open ? '▲ Hide logs' : '▼ Show recent logs'}</button>
      <span class="sp"></span>
      ${actions(s)}
    </div>
    ${open ? `<pre class="dd-logs">${preview.length ? preview.map(e).join('\n') : '<span class="dim">No recent logs</span>'}</pre>` : ''}
    ${lastMsg ? `<div class="dd-last">Last: ${e(lastMsg)}</div>` : ''}
  </article>`;
}

function infraRow(s) {
  const e = D.esc;
  const c = s.containers[0] || { name: '' };
  return `<div class="card dd-row">
    ${badge(statusOf(c))}
    <b>${e(s.name)}</b><code>${e(s.containers.map((x) => x.name).join(', '))}</code>
    <span class="sp"></span>
    ${c.info?.uptime ? `<span class="dim">up ${e(c.info.uptime)}</span>` : ''}
    ${c.info?.restartCount > 0 ? `<span class="warn">${c.info.restartCount} restarts</span>` : ''}
    ${c.info ? logsBtn(c.name) : ''}
    ${actions(s)}
  </div>`;
}

function backupRow(b, err) {
  const e = D.esc;
  if (!b) return `<div class="card dd-row">${badge('unknown')}<b>MySQL Backup</b><span class="dim">${err ? e(err) : 'no status yet'}</span></div>`;
  const age = Date.now() - new Date(b.timestamp).getTime();
  const stale = Number.isFinite(age) && age > STALE_BACKUP_MS;
  const state = !b.success ? badge('stopped', 'Failed') : stale ? badge('restarting', 'Stale') : badge('running', 'OK');
  return `<div class="card dd-row">
    ${state}<b>MySQL Backup</b>
    ${b.error ? `<span class="dd-err">${e(b.error)}</span>` : stale ? '<span class="warn">no run in over 26h</span>' : ''}
    <span class="sp"></span>
    ${b.sizeMb != null ? `<span class="dim">${e(b.sizeMb)} MB</span>` : ''}
    <span class="${stale ? 'warn' : 'dim'}">${ago(b.timestamp)}</span>
  </div>`;
}

function render() {
  const meta = $('devMeta');
  meta.className = 'cam-status' + (D.error ? ' bad' : D.data ? ' ok' : '');
  meta.textContent = D.error ? `Can't reach Portal's server${D.at ? ` · as of ${ago(D.at)}` : ''}` : D.at ? `Updated ${ago(D.at)}` : 'Loading…';

  const d = D.data;
  let html = '<div class="empty">Loading…</div>';
  if (d?.services) {
    const of = (k) => d.services.filter((s) => s.kind === k);
    const section = (title, list, body) => (list.length ? `<h3 class="dd-h">${title}</h3>${body}` : '');
    html = `
      ${d.docker ? `<div class="card dd-row dd-warn">${badge('stopped', 'Docker')}<span>Can't read Docker: ${D.esc(d.docker)}</span></div>` : ''}
      ${section('Applications', of('app'), `<div class="dd-grid">${of('app').map(serviceCard).join('')}</div>`)}
      ${section('Bots', of('bot'), `<div class="dd-grid">${of('bot').map(serviceCard).join('')}</div>`)}
      ${section('Infrastructure', of('infra'), `<div class="dd-grid dd-infra">${of('infra').map(infraRow).join('')}</div>`)}
      <h3 class="dd-h">Backups</h3>
      ${backupRow(d.backup, d.backupError)}`;
  }
  // Only touch the DOM when something changed, so open log panes keep their scroll position.
  if (html !== D.html) { $('devBody').innerHTML = html; D.html = html; }
}

async function refresh() {
  try {
    D.data = await D.api('api/devdash');
    D.at = Date.now();
    D.error = null;
    try { localStorage.setItem(KEY, JSON.stringify({ data: D.data, at: D.at })); } catch {}
  } catch (err) {
    D.error = err.message;
  }
  render();
}

/* ---------- add / edit ---------- */

async function openForm(name) {
  const f = $('devForm');
  let s = { name: '', kind: 'app', containers: [], healthUrl: null, webUrl: null, oneShot: [] };
  if (name) {
    try {
      const reg = await D.api('api/devdash/services');
      s = reg.services.find((x) => x.name === name) || s;
    } catch (err) { D.toast?.(err.message, false); return; }
  }
  D.form = { original: name || null, oneShot: s.oneShot || [] };
  const e = D.esc;
  f.innerHTML = `<form class="card dd-form" id="devFormEl">
    <div class="card-h"><h2>${name ? `Edit ${e(name)}` : 'Track something new'}</h2></div>
    <div class="dd-fields">
      <label>Name<input class="field" name="name" required maxlength="40" value="${e(s.name)}"></label>
      <label>Kind<select class="field" name="kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}"${k === s.kind ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="wide">Containers<input class="field" name="containers" required placeholder="quest-web quest-api" value="${e(s.containers.join(' '))}"></label>
      <label class="wide">Health URL<input class="field" name="healthUrl" placeholder="http://quest-api:3007/health (optional)" value="${e(s.healthUrl || '')}"></label>
      <label class="wide">Web URL<input class="field" name="webUrl" placeholder="http://synology:3006 (optional)" value="${e(s.webUrl || '')}"></label>
    </div>
    <p class="note">Container names as Docker knows them, separated by spaces. The health URL is fetched from inside Portal, which is on the shared-db network, so container hostnames work.</p>
    <p class="err" id="devFormErr" hidden></p>
    <div class="dd-formbtns"><span class="sp"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${name ? 'Save' : 'Add'}</button></div>
  </form>`;
  f.hidden = false;
  f.querySelector('[name=name]').focus();
}

function closeForm() {
  D.form = null;
  $('devForm').hidden = true;
  $('devForm').innerHTML = '';
}

async function submitForm(form) {
  const v = Object.fromEntries(new FormData(form));
  const body = {
    name: v.name.trim(),
    kind: v.kind,
    containers: v.containers.split(/[\s,]+/).filter(Boolean),
    healthUrl: v.healthUrl.trim() || null,
    webUrl: v.webUrl.trim() || null,
    oneShot: D.form.oneShot,
  };
  const orig = D.form.original;
  try {
    await D.api(orig ? `api/devdash/services/${encodeURIComponent(orig)}` : 'api/devdash/services', { method: orig ? 'PUT' : 'POST', body: JSON.stringify(body) });
    closeForm();
    refresh();
  } catch (err) {
    const el = $('devFormErr');
    el.textContent = err.message;
    el.hidden = false;
  }
}

async function remove(name) {
  D.confirm = null;
  try {
    await D.api(`api/devdash/services/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (D.data?.services) D.data.services = D.data.services.filter((s) => s.name !== name);
  } catch (err) { D.toast?.(err.message, false); }
  render();
  refresh();
}

/* ---------- live logs ---------- */

function openLogs(name, since = '2h') {
  closeLogs();
  const L = { name, since, es: null, lines: [], paused: false, filter: D.logs?.name === name ? D.logs.filter : '' };
  D.logs = L;
  const v = $('devLogs');
  const e = D.esc;
  v.innerHTML = `<div class="dd-lv-bar">
      <b><code>${e(name)}</code></b>
      <div class="seg">${['2h', '6h', '24h'].map((s) => `<button data-since="${s}" aria-pressed="${s === since}">Last ${s}</button>`).join('')}</div>
      <input class="field" id="devLogFilter" placeholder="Filter…" value="${e(L.filter)}">
      <button class="btn" id="devLogPause">Pause</button>
      <span class="dd-dot" id="devLogDot" title="Disconnected"></span>
      <span class="dim" id="devLogCount">0 lines</span>
      <span class="sp"></span>
      <button class="iconbtn" data-close-logs aria-label="Close logs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="dd-lv-out" id="devLogOut"></div>`;
  v.hidden = false;
  document.body.classList.add('dd-logs-open');

  const es = new EventSource(`api/devdash/logs/${encodeURIComponent(name)}?since=${since}`);
  L.es = es;
  es.onopen = () => { const d = $('devLogDot'); d.classList.add('on'); d.title = 'Connected'; };
  es.onmessage = (ev) => {
    let line;
    try { line = JSON.parse(ev.data); } catch { return; }
    L.lines.push(line);
    if (L.lines.length > 3000) L.lines.splice(0, L.lines.length - 2000);
    if (!L.paused) appendLine(line);
    $('devLogCount').textContent = `${L.lines.length} lines`;
  };
  es.addEventListener('fail', (ev) => { try { appendLine({ text: JSON.parse(ev.data).error, err: true }); } catch {} });
  es.onerror = () => { const d = $('devLogDot'); if (d) { d.classList.remove('on'); d.title = 'Disconnected'; } es.close(); };
}

const matches = (line) => !D.logs.filter || line.text.toLowerCase().includes(D.logs.filter.toLowerCase());

function appendLine(line) {
  if (!matches(line)) return;
  const out = $('devLogOut');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const div = document.createElement('div');
  div.textContent = line.text;
  if (line.err) div.className = 'err';
  out.appendChild(div);
  while (out.childElementCount > 2000) out.firstChild.remove();
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function redrawLogs() {
  const out = $('devLogOut');
  out.innerHTML = '';
  for (const l of D.logs.lines.slice(-2000)) appendLine(l);
  out.scrollTop = out.scrollHeight;
}

function closeLogs() {
  if (!D.logs) return;
  D.logs.es?.close();
  D.logs = null;
  $('devLogs').hidden = true;
  $('devLogs').innerHTML = '';
  document.body.classList.remove('dd-logs-open');
}

/* ---------- wiring ---------- */

export function initDevdash({ api, esc, toast }) {
  D.api = api;
  D.esc = esc;
  D.toast = toast;
  $('devRefresh').onclick = refresh;
  $('devAdd').onclick = () => openForm(null);

  $('devBody').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.toggle) {
      const n = t.dataset.toggle;
      if (D.open.has(n)) D.open.delete(n); else D.open.add(n);
      render();
    } else if (t.dataset.logs) openLogs(t.dataset.logs);
    else if (t.dataset.edit) openForm(t.dataset.edit);
    else if (t.dataset.ask) { D.confirm = t.dataset.ask; render(); }
    else if ('cancel' in t.dataset) { D.confirm = null; render(); }
    else if (t.dataset.remove) remove(t.dataset.remove);
  });

  $('devForm').addEventListener('submit', (ev) => { ev.preventDefault(); submitForm(ev.target); });
  $('devForm').addEventListener('click', (ev) => { if (ev.target.closest('[data-close]')) closeForm(); });

  const lv = $('devLogs');
  lv.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t || !D.logs) return;
    if ('closeLogs' in t.dataset) closeLogs();
    else if (t.dataset.since) openLogs(D.logs.name, t.dataset.since);
    else if (t.id === 'devLogPause') {
      D.logs.paused = !D.logs.paused;
      t.textContent = D.logs.paused ? 'Resume' : 'Pause';
      if (!D.logs.paused) redrawLogs();
    }
  });
  lv.addEventListener('input', (ev) => {
    if (ev.target.id !== 'devLogFilter' || !D.logs) return;
    D.logs.filter = ev.target.value;
    redrawLogs();
  });
}

export function showDevdash() {
  render();
  refresh();
  clearInterval(D.timer);
  D.timer = setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
}

export function hideDevdash() {
  clearInterval(D.timer);
  D.timer = null;
  closeLogs();
  closeForm();
}

/** Keys while the DevDash tab is showing (Escape arrives even while typing). Returns true when handled. */
export function devdashKey(e) {
  if (e.key === 'Escape') {
    if (D.logs) { closeLogs(); return true; }
    if (D.form) { closeForm(); return true; }
    if (D.confirm) { D.confirm = null; render(); return true; }
    return false;
  }
  if (D.logs || D.form) return false;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refresh(); return true; }
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openForm(null); return true; }
  return false;
}
