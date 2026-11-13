/* The DevDash tab: DevDash's cards (projects, infrastructure, MySQL backup), read through Portal's
 * /api/devdash, which proxies DevDash's own API. Logs stay in DevDash; "Logs" links open it there.
 * Paints from localStorage first, then polls every 10 s while the tab is showing. */

const DEVDASH = 'http://synology:3005';
const KEY = 'portal-devdash-v1';
const STALE_BACKUP_MS = 26 * 3600e3; // the backup runs daily at 1 am

const D = { api: null, esc: null, data: null, at: 0, error: null, timer: null, open: new Set(), html: '' };
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

const BADGES = { running: ['ok', 'Running'], stopped: ['down', 'Stopped'], restarting: ['warn', 'Restarting'], unknown: ['', 'Unknown'] };
function badge(status, label) {
  const [cls, text] = BADGES[status] || BADGES.unknown;
  return `<span class="dd-badge ${cls}"><i></i>${label ?? text}</span>`;
}
const logsLink = (name) => `<a class="dd-link" href="${DEVDASH}/logs/${encodeURIComponent(name)}" target="_blank" rel="noopener">Logs</a>`;

function projectCard(p) {
  const e = D.esc;
  const cs = p.containers || [];
  const errors = cs.reduce((n, c) => n + (c.errorCount || 0), 0);
  const overall = cs.some((c) => c.info?.status === 'restarting') ? 'restarting'
    : cs.length && cs.every((c) => c.info?.status === 'running') ? 'running' : 'stopped';
  const h = p.health;
  const open = D.open.has(p.name);
  const lastError = errors > 0 ? cs.map((c) => c.lastError).find(Boolean) : null;
  const lastMsg = !p.healthUrl ? cs.map((c) => c.lastMessage).find(Boolean) : null;
  const preview = cs[0]?.logPreview || [];

  return `<article class="card dd-card${overall !== 'running' ? ' bad' : ''}" data-name="${e(p.name)}">
    <div class="dd-head">
      ${badge(overall)}
      <h2>${e(p.name)}</h2>
      ${errors ? `<span class="dd-errs">${errors} error${errors === 1 ? '' : 's'}</span>` : ''}
      <span class="sp"></span>
      ${p.webUrl ? `<a class="dd-link" href="${e(p.webUrl)}" target="_blank" rel="noopener">Open →</a>` : ''}
    </div>
    ${h ? `<div class="dd-health ${h.ok ? 'ok' : 'down'}">
      <b>${h.ok ? '✓ Healthy' : '✗ Unhealthy'}</b>
      ${h.latencyMs > 0 ? `<span>${h.latencyMs}ms</span>` : ''}
      ${h.db ? `<span>DB: ${e(h.db)}</span>` : ''}
      ${h.error ? `<span class="dd-err">${e(h.error)}</span>` : ''}
    </div>` : ''}
    <ul class="dd-rows">${cs.map((c) => `<li>
      ${badge(c.info?.status ?? 'unknown')}
      <code>${e(c.name)}</code>
      <span class="sp"></span>
      ${c.info?.uptime ? `<span class="dim">up ${e(c.info.uptime)}</span>` : ''}
      ${c.info?.restartCount > 0 ? `<span class="warn">${c.info.restartCount} restart${c.info.restartCount === 1 ? '' : 's'}</span>` : ''}
      ${logsLink(c.name)}
    </li>`).join('')}</ul>
    ${(p.oneShot || []).map((s) => {
      const ran = s.finishedAt && s.finishedAt !== '0001-01-01T00:00:00Z';
      return `<div class="dd-oneshot"><span>${e(s.name)}:</span>${ran
        ? `<span class="${s.exitCode === 0 ? 'ok' : 'down'}">${s.exitCode === 0 ? 'OK' : `exit ${e(s.exitCode)}`}</span><span class="dim">${ago(s.finishedAt)}</span>${logsLink(s.container)}`
        : '<span class="dim">never run</span>'}</div>`;
    }).join('')}
    ${lastError ? `<pre class="dd-lasterr">${e(lastError)}</pre>` : ''}
    <button class="dd-toggle" data-toggle="${e(p.name)}" aria-expanded="${open}">${open ? '▲ Hide logs' : '▼ Show recent logs'}</button>
    ${open ? `<pre class="dd-logs">${preview.length ? preview.map(e).join('\n') : '<span class="dim">No recent logs</span>'}</pre>` : ''}
    ${lastMsg ? `<div class="dd-last">Last: ${e(lastMsg)}</div>` : ''}
  </article>`;
}

function infraRow(s) {
  const e = D.esc;
  return `<div class="card dd-row">
    ${badge(s.info?.status ?? 'unknown')}
    <b>${e(s.name)}</b><code>${e(s.container)}</code>
    <span class="sp"></span>
    ${s.info?.uptime ? `<span class="dim">up ${e(s.info.uptime)}</span>` : ''}
    ${s.info?.restartCount > 0 ? `<span class="warn">${s.info.restartCount} restarts</span>` : ''}
  </div>`;
}

function backupRow(b) {
  const e = D.esc;
  if (!b) return `<div class="card dd-row">${badge('unknown')}<b>MySQL Backup</b><span class="dim">no status yet</span></div>`;
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
  const el = $('dev');
  const meta = $('devMeta');
  meta.className = 'cam-status' + (D.error ? ' bad' : D.data ? ' ok' : '');
  meta.textContent = D.error ? `Can't reach DevDash${D.at ? ` · as of ${ago(D.at)}` : ''}` : D.at ? `Updated ${ago(D.at)}` : 'Loading…';

  const d = D.data;
  // The Discord bots (AlpacaBot, BSNSFWBot) get their own section; DevDash's registry has no type field.
  const isBot = (p) => /bot$/i.test(p.name);
  const apps = d ? d.projects.filter((p) => !isBot(p)) : [];
  const bots = d ? d.projects.filter(isBot) : [];
  const html = !d ? '<div class="empty">Loading…</div>' : `
    <h3 class="dd-h">Applications</h3>
    <div class="dd-grid">${apps.map(projectCard).join('')}</div>
    ${bots.length ? `<h3 class="dd-h">Bots</h3>
    <div class="dd-grid">${bots.map(projectCard).join('')}</div>` : ''}
    <h3 class="dd-h">Infrastructure</h3>
    <div class="dd-grid dd-infra">${d.infrastructure.map(infraRow).join('')}</div>
    <h3 class="dd-h">Backups</h3>
    ${backupRow(d.backup)}`;
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

export function initDevdash({ api, esc }) {
  D.api = api;
  D.esc = esc;
  $('devRefresh').onclick = refresh;
  $('devBody').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-toggle]');
    if (!b) return;
    const n = b.dataset.toggle;
    if (D.open.has(n)) D.open.delete(n); else D.open.add(n);
    render();
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
}

/** Keys while the DevDash tab is showing. Returns true when it handled the key. */
export function devdashKey(e) {
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refresh(); return true; }
  return false;
}
