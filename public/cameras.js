/* Cameras tab. The cameras sit side by side, each with its own stage and timeline. One stage
 * shows that camera's stills (scrub or timelapse), an event clip, Ring live view, or yesterday's
 * daily summary. A timelapse that reaches an event plays its clip, then carries on. One event list
 * below covers every camera showing.
 *
 * Ring stills are its 30 s interval snapshots; Reolink stills are the one JPG it uploads per
 * event. Reolink clips are 4K HEVC and play as uploaded, so a browser without HEVC gets a notice
 * pointing at Yesterday (H.264) instead. */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yesterday = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)); };
const fmtClock = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${h % 12 || 12}:${pad(m)}:${pad(s)} ${h < 12 ? 'AM' : 'PM'}`;
};
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`);
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
const dayLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/* Per-browser preferences: camera filter, speeds per player, mute. */
const PREFS_KEY = 'portal-cams-v1';
let prefs = { filter: 'all', muted: false, rates: { timelapse: 1, clip: 1, summary: 2 } };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

/** Timelapse speed: 1× is five stills a second. */
const BASE_FPS = 5;

const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L153.B0"';
const hevcOk = (() => {
  try {
    return Boolean(window.MediaSource?.isTypeSupported?.(HEVC_TYPE)) || document.createElement('video').canPlayType(HEVC_TYPE) !== '';
  } catch {
    return false;
  }
})();

let ctx = null; // { api, esc, toast } from app.js
const C = {
  ready: false,
  visible: false,
  cams: [],
  mqtt: true,
  summary: null,
  date: isoDay(new Date()),
  yest: false,   // the Yesterday button is on
  days: {},      // slug → { snapshots, events } for C.date
  dayLists: {},  // slug → every day with footage
  panels: [],    // one per camera showing, in order
  panelKey: '',
  focus: null,   // the panel keys act on: the one last touched
  timers: [],
};

const camBy = (slug) => C.cams.find((c) => c.slug === slug);
const shown = () => (prefs.filter === 'all' ? C.cams : C.cams.filter((c) => c.slug === prefs.filter));
const panelFor = (slug) => C.panels.find((p) => p.slug === slug);
const stills = (p) => C.days[p.slug]?.snapshots || [];
const esc = (s) => ctx.esc(s);
const camName = (p) => camBy(p.slug)?.name ?? '';

/** The daily summary is every Reolink upload concatenated, so it belongs to the (first) Reolink. */
function summaryFor(p) {
  const s = C.summary;
  if (!s?.video || s.date !== C.date) return null;
  return C.cams.find((c) => c.kind === 'reolink')?.slug === p.slug ? s : null;
}

/* ================= panels ================= */

const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const HOURS = Array.from({ length: 24 }, (_, h) => `<span>${h % 12 || 12}${h < 12 ? 'a' : 'p'}</span>`).join('');

const panelHtml = (c) => `<div class="cam-panel" data-slug="${esc(c.slug)}">
  <div class="cam-stage">
    <img class="cam-frame" alt="" hidden>
    <video controls playsinline controlslist="noplaybackrate" disablepictureinpicture hidden></video>
    <div class="cam-empty" hidden></div>
    <div class="cam-over"><span class="cam-when tnum"></span></div>
    <div class="live-note" hidden>Ring pauses motion events while live view is open, so nothing records until you close it.</div>
  </div>
  <div class="cam-ctl">
    <button class="iconbtn" data-act="play" aria-label="Play" title="Play / pause  (Space)"></button>
    <div class="seg" aria-label="Speed"><button data-r="1">1×</button><button data-r="2">2×</button><button data-r="4">4×</button></div>
    <span class="note cam-rate-label"></span>
    <span class="sp"></span>
    <button class="btn live-btn" data-act="live" hidden>● Live</button>
  </div>
  <div class="timeline">
    <div class="hours">${HOURS}</div>
    <div class="lane"><div class="density"></div><div class="marks"></div></div>
    <div class="cursor" hidden></div>
  </div>
</div>`;

/** Builds one panel per camera showing, when that set changes. */
function renderPanels() {
  const list = shown();
  const key = list.map((c) => c.slug).join();
  if (key === C.panelKey) return;
  C.panelKey = key;
  for (const p of C.panels) resetStage(p);
  const box = $('camPanels');
  if (!list.length) {
    box.innerHTML = '<div class="cam-none">No cameras yet. Ring cameras appear once ring-mqtt reports them; Reolink cameras once they upload.</div>';
    C.panels = [];
    C.focus = null;
    return;
  }
  box.innerHTML = list.map(panelHtml).join('');
  C.panels = [...box.querySelectorAll('.cam-panel')].map((el) => {
    const q = (s) => el.querySelector(s);
    const p = {
      slug: el.dataset.slug, el,
      frame: q('.cam-frame'), video: q('video'), empty: q('.cam-empty'), when: q('.cam-when'),
      liveNote: q('.live-note'), play: q('[data-act="play"]'),
      rate: q('.seg'), rateLabel: q('.cam-rate-label'), liveBtn: q('[data-act="live"]'),
      lane: q('.lane'), cursor: q('.cursor'),
      mode: 'frame', // frame | clip | live | summary | notice
      pos: -1, clip: null, live: null, playing: null, lapse: null, sumI: -1, playIcon: null,
    };
    wireVideo(p);
    return p;
  });
  if (!C.panels.includes(C.focus)) C.focus = C.panels[0];
  renderFocus();
}

function setFocus(p) {
  if (C.focus === p) return;
  C.focus = p;
  renderFocus();
}
const renderFocus = () => C.panels.forEach((p) => p.el.classList.toggle('focus', p === C.focus && C.panels.length > 1));

/* ================= stage ================= */

function nearest(list, t) {
  if (!list.length) return -1;
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && t - list[lo - 1].t < list[lo].t - t ? lo - 1 : lo;
}

const preloaded = new Set();
function preload(p, from) {
  const s = stills(p);
  for (let i = from + 1; i < from + 6 && i < s.length; i++) {
    if (preloaded.has(s[i].file)) continue;
    preloaded.add(s[i].file);
    new Image().src = s[i].file;
  }
}

function setCursor(p, t) {
  p.cursor.hidden = t == null;
  if (t != null) p.cursor.style.left = `${(t / 86400) * 100}%`;
}

function resetStage(p) {
  stopTimelapse(p);
  stopLive(p);
  closeVideo(p);
  p.lapse = null;
  p.frame.hidden = true;
  p.empty.hidden = true;
  p.liveNote.hidden = true;
}

function showFrame(p, pos) {
  const s = stills(p);
  if (!s.length) return showEmpty(p);
  if (p.mode !== 'frame') resetStage(p);
  p.mode = 'frame';
  p.pos = Math.max(0, Math.min(s.length - 1, pos));
  const snap = s[p.pos];
  p.frame.hidden = false;
  p.empty.hidden = true;
  p.frame.src = snap.file;
  p.when.textContent = `${camName(p)} · ${fmtClock(snap.t)} · ${p.pos + 1} of ${s.length}`;
  setCursor(p, snap.t);
  preload(p, p.pos);
  renderControls(p);
}

function showEmpty(p) {
  resetStage(p);
  p.mode = 'frame';
  p.pos = -1;
  p.empty.hidden = false;
  const evs = C.days[p.slug]?.events.length;
  p.empty.textContent = evs ? 'No stills this day. Pick an event.' : `Nothing on ${dayLabel(C.date)}.`;
  p.when.textContent = camName(p);
  setCursor(p, null);
  renderControls(p);
}

/** A message on the stage with optional buttons (`data-act`). */
function showNotice(p, html) {
  resetStage(p);
  p.mode = 'notice';
  p.empty.hidden = false;
  p.empty.innerHTML = html;
  renderControls(p);
}

function openVideo(p, src, rate, poster = '', autoplay = true) {
  const v = p.video;
  p.frame.hidden = true;
  p.empty.hidden = true;
  v.hidden = false;
  v.poster = poster;
  v.src = src;
  // Changing src resets playbackRate to the default, so set both.
  v.defaultPlaybackRate = v.playbackRate = rate;
  v.muted = prefs.muted;
  if (autoplay) v.play().catch(() => {});
}

function closeVideo(p) {
  const v = p.video;
  if (v.hidden) return;
  v.pause();
  v.removeAttribute('src');
  v.removeAttribute('poster');
  v.load();
  v.hidden = true;
  p.clip = null;
}

const isShare = (file) => file.startsWith('share/');

/** `lapse`: the clip came up in a timelapse, which picks up again after it ends. */
function playClip(p, ev, force = false, lapse = false) {
  resetStage(p);
  if (isShare(ev.file) && !hevcOk && !force) return hevcNotice(p, ev);
  p.mode = 'clip';
  p.clip = ev;
  p.lapse = lapse ? ev.t + ev.duration : null;
  openVideo(p, ev.file, prefs.rates.clip);
  p.when.textContent = `${camName(p)} · ${fmtClock(ev.t)} · ${ev.kind === 'ding' ? 'Doorbell' : 'Motion'}`;
  setCursor(p, ev.t);
  renderTimeline(p);
  renderEvents();
  renderControls(p);
}

const playable = (e) => hevcOk || !isShare(e.file);

/** This camera's next event after `cur`, skipping clips this browser can't play. */
function nextClip(p, cur) {
  let next = null;
  for (const e of C.days[p.slug]?.events || []) {
    if (!playable(e)) continue;
    const after = e.t > cur.t || (e.t === cur.t && e.file > cur.file);
    if (after && (!next || e.t < next.t || (e.t === next.t && e.file < next.file))) next = e;
  }
  return next;
}

function hevcNotice(p, ev) {
  showNotice(p, `<p>This browser can't play the Reolink's 4K HEVC clips.<br><small>Edge, Safari, and Chrome with hardware video decoding can.</small></p>
    <p><button class="btn" data-act="force">Try anyway</button> ${C.summary?.video ? '<button class="btn" data-act="yesterday">Watch Yesterday</button>' : ''} <button class="btn" data-act="back">Back to timeline</button></p>`);
  p.clip = ev; // after showNotice, which clears the stage
  p.when.textContent = `${camName(p)} · ${fmtClock(ev.t)}`;
  setCursor(p, ev.t);
  renderEvents();
}

function backToTimeline(p) {
  const t = p.clip ? p.clip.t + (p.video.currentTime || 0) : null;
  resetStage(p);
  p.mode = 'frame';
  renderTimeline(p);
  renderEvents();
  const s = stills(p);
  if (t != null && s.length) showFrame(p, nearest(s, t));
  else showFrame(p, C.date === isoDay(new Date()) ? s.length - 1 : 0);
}

function showSummary(p) {
  const s = summaryFor(p);
  if (!s) return;
  resetStage(p);
  p.mode = 'summary';
  p.sumI = -1;
  // It's long, so it waits on the poster for Play.
  openVideo(p, s.video, prefs.rates.summary, s.poster, false);
  p.when.textContent = `${camName(p)} · ${dayLabel(s.date)} · daily summary`;
  followSummary(p);
  renderEvents();
  renderControls(p);
}

/* The summary is the day's Reolink clips back to back, so a point in it maps to a clock time.
 * Clip lengths are rounded to the second, so the offsets are scaled to the summary's real length. */
function summaryScale(p) {
  const evs = C.days[p.slug]?.events || [];
  const total = evs.reduce((n, e) => n + e.duration, 0);
  return { evs, k: total && p.video.duration ? p.video.duration / total : 1 };
}

/** Moves the cursor (and the lit event mark) along with the summary. */
function followSummary(p) {
  const { evs, k } = summaryScale(p);
  if (!evs.length) return setCursor(p, null);
  let at = (p.video.currentTime || 0) / k, i = 0;
  while (i < evs.length - 1 && at >= evs[i].duration) at -= evs[i++].duration;
  setCursor(p, evs[i].t + Math.min(at, evs[i].duration));
  if (i === p.sumI) return;
  p.sumI = i;
  for (const b of p.lane.querySelectorAll('.marks b')) b.classList.toggle('on', +b.dataset.i === i);
}

/** Seeks the summary to clock time `t`: into the clip recording then, or the start of the nearest. */
function seekSummary(p, t) {
  const { evs, k } = summaryScale(p);
  if (!evs.length || !p.video.duration) return;
  const gap = (e) => (t < e.t ? e.t - t : Math.max(0, t - e.t - e.duration));
  let best = 0;
  for (let i = 1; i < evs.length; i++) if (gap(evs[i]) < gap(evs[best])) best = i;
  let at = Math.max(0, Math.min(evs[best].duration, t - evs[best].t));
  for (let i = 0; i < best; i++) at += evs[i].duration;
  p.video.currentTime = Math.min(p.video.duration - 0.1, at * k);
  followSummary(p);
}

/* ================= yesterday ================= */

/** Every camera on yesterday, paused at the start: the daily summary where there is one, the
 * stills elsewhere. */
async function showYesterday() {
  await setDate(yesterday(), { yest: true });
  if (!C.yest) return; // the day changed again while loading
  for (const p of C.panels) {
    if (summaryFor(p)) showSummary(p);
    else if (stills(p).length) showFrame(p, 0);
  }
}

function leaveYesterday() {
  C.yest = false;
  for (const p of C.panels) p.mode === 'frame' ? stopTimelapse(p) : backToTimeline(p);
  renderBar();
}

/* ================= live view (Ring) ================= */

let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve();
  hlsLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
    s.onload = resolve;
    s.onerror = () => { hlsLoading = null; reject(new Error("Couldn't load the video player")); };
    document.head.append(s);
  });
  return hlsLoading;
}

/** The panel L acts on: the focused one, or else the first that can go live. */
const liveTarget = () => (camBy(C.focus?.slug)?.canLive ? C.focus : C.panels.find((p) => camBy(p.slug)?.canLive));

async function startLive(p) {
  const cam = camBy(p.slug);
  if (!cam?.canLive || p.live) return;
  resetStage(p);
  p.mode = 'live';
  const live = (p.live = { hls: null, timer: null });
  p.empty.hidden = false;
  p.empty.textContent = 'Starting live view… (Ring takes a few seconds)';
  p.when.textContent = `${cam.name} · Live`;
  p.liveNote.hidden = false;
  setCursor(p, null);
  renderControls(p);
  renderTimeline(p);

  const url = `api/cameras/${cam.slug}/live`;
  const ping = () => ctx.api(url, { method: 'POST' });
  try {
    let s = await ping();
    for (let i = 0; !s.ready && i < 30 && p.live === live; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await ping();
    }
    if (p.live !== live) return;
    if (!s.ready) throw new Error(`${cam.name}'s stream didn't start.`);
    live.timer = setInterval(() => ping().catch(() => {}), 10_000);
    const v = p.video;
    p.empty.hidden = true;
    v.hidden = false;
    v.defaultPlaybackRate = v.playbackRate = 1;
    v.muted = prefs.muted;
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = s.playlist; // Safari plays HLS natively
    } else {
      await loadHls();
      if (p.live !== live) return;
      live.hls = new Hls({ liveSyncDurationCount: 2 });
      live.hls.loadSource(s.playlist);
      live.hls.attachMedia(v);
    }
    v.play().catch(() => {});
  } catch (err) {
    if (p.live !== live) return;
    stopLive(p);
    showNotice(p, `<p>Live view failed: ${esc(err.message)}</p><p><button class="btn" data-act="back">Back to timeline</button></p>`);
  }
}

function stopLive(p) {
  const live = p.live;
  if (!live) return;
  p.live = null;
  clearInterval(live.timer);
  live.hls?.destroy();
  const v = p.video;
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.hidden = true;
  p.liveNote.hidden = true;
  fetch(`api/cameras/${p.slug}/live`, { method: 'DELETE', keepalive: true }).catch(() => {});
  if (p.mode === 'live') p.mode = 'frame';
}

/* ================= playback controls ================= */

const rateKey = (p) => (p.mode === 'clip' ? 'clip' : p.mode === 'summary' ? 'summary' : 'timelapse');
const isVideo = (p) => p.mode === 'clip' || p.mode === 'summary';

/** Plays the stills forward. An event it reaches plays as a clip, and the timelapse picks up
 * again after the clip (`covered` is the clock time played so far; `from` resumes there). */
function startTimelapse(p, from = null) {
  const s = stills(p);
  if (!s.length) return;
  if (from == null) {
    if (p.mode !== 'frame') showFrame(p, Math.max(0, p.pos));
    // From the last still, start over.
    if (p.pos >= s.length - 1) showFrame(p, 0);
  }
  let covered = from ?? (p.pos === 0 ? 0 : s[p.pos].t);
  clearInterval(p.playing);
  p.playing = setInterval(() => {
    const s = stills(p);
    if (p.pos >= s.length - 1) return stopTimelapse(p);
    const upTo = s[p.pos + 1].t;
    const ev = (C.days[p.slug]?.events || [])
      .filter((e) => e.t >= covered && e.t <= upTo && playable(e))
      .sort((a, b) => a.t - b.t)[0];
    if (ev) return playClip(p, { ...ev, slug: p.slug }, false, true);
    showFrame(p, p.pos + 1);
    covered = upTo;
  }, 1000 / (BASE_FPS * prefs.rates.timelapse));
  renderControls(p);
}

/** After a timelapse's clip: back to the stills, from where the clip ended. */
function resumeTimelapse(p) {
  const t = p.lapse;
  const s = stills(p);
  if (!s.length) return backToTimeline(p);
  showFrame(p, Math.max(0, s.findLastIndex((x) => x.t <= t)));
  startTimelapse(p, t);
}

function stopTimelapse(p) {
  if (!p.playing) return;
  clearInterval(p.playing);
  p.playing = null;
  renderControls(p);
}

function togglePlay(p) {
  const v = p.video;
  if (isVideo(p)) v.paused ? v.play().catch(() => {}) : v.pause();
  else if (p.mode === 'frame') p.playing ? stopTimelapse(p) : startTimelapse(p);
  renderControls(p);
}

function renderControls(p) {
  const playing = isVideo(p) ? !p.video.paused : Boolean(p.playing);
  p.play.disabled = p.mode === 'live' || p.mode === 'notice' || (p.mode === 'frame' && !stills(p).length);
  // Only on a change: a timelapse repaints every frame, and swapping the icon under the pointer
  // between press and release swallows the click.
  if (p.playIcon !== playing) {
    p.playIcon = playing;
    p.play.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    p.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  const r = prefs.rates[rateKey(p)];
  for (const b of p.rate.children) {
    b.setAttribute('aria-pressed', String(+b.dataset.r === r));
    b.disabled = p.mode === 'live' || p.mode === 'notice';
  }
  p.rateLabel.textContent = p.mode === 'frame' ? 'timelapse' : p.mode === 'clip' ? 'clip' : p.mode === 'summary' ? 'summary' : '';
  const cam = camBy(p.slug);
  p.liveBtn.hidden = !cam?.canLive;
  p.liveBtn.classList.toggle('on', p.mode === 'live');
  p.liveBtn.textContent = p.mode === 'live' ? '■ Stop live' : '● Live';
  p.liveBtn.title = cam?.canLive ? `Watch ${cam.name} live (L)` : '';
}

function renderBar() {
  $('camYest').hidden = !C.cams.length;
  $('camYest').setAttribute('aria-pressed', String(C.yest));
}

function setRate(p, r) {
  if (p.mode === 'live' || p.mode === 'notice') return;
  prefs.rates[rateKey(p)] = r;
  savePrefs();
  // The other panels in the same kind of player follow, since the speed is one preference.
  for (const q of C.panels) {
    if (rateKey(q) !== rateKey(p) || q.mode === 'live' || q.mode === 'notice') continue;
    if (isVideo(q)) q.video.defaultPlaybackRate = q.video.playbackRate = r;
    else if (q.playing) startTimelapse(q);
    renderControls(q);
  }
}

/* ================= timeline ================= */

function renderTimeline(p) {
  const d = C.days[p.slug] || { snapshots: [], events: [] };
  // Coverage strip: one block per 10-minute bucket that has a still or part of a clip.
  const buckets = new Set(d.snapshots.map((s) => Math.floor(s.t / 600)));
  for (const e of d.events) for (let b = Math.floor(e.t / 600); b <= Math.floor(Math.min(86399, e.t + e.duration) / 600); b++) buckets.add(b);
  p.lane.querySelector('.density').innerHTML = [...buckets].map((b) => `<i style="left:${(b / 144) * 100}%;width:${100 / 144}%"></i>`).join('');
  p.lane.querySelector('.marks').innerHTML = d.events.map((e, i) => `<b class="${e.kind}${p.clip?.file === e.file || (p.mode === 'summary' && p.sumI === i) ? ' on' : ''}" data-i="${i}" title="${fmtClock(e.t)} · ${e.kind === 'ding' ? 'doorbell' : 'motion'}" style="left:${(e.t / 86400) * 100}%;width:${(e.duration / 86400) * 100}%"></b>`).join('');
}

function timeAt(p, clientX) {
  const r = p.lane.getBoundingClientRect();
  return Math.max(0, Math.min(86399, ((clientX - r.left) / r.width) * 86400));
}

let dragging = null;
function scrubTo(p, clientX) {
  if (p.mode === 'summary') return seekSummary(p, timeAt(p, clientX));
  const s = stills(p);
  if (!s.length) return showEmpty(p);
  showFrame(p, nearest(s, timeAt(p, clientX)));
}

/* ================= events ================= */

/** A still taken during the event (or close to it), for the event list. */
function thumbFor(ev) {
  const s = C.days[ev.slug]?.snapshots || [];
  const during = s.find((x) => x.t >= ev.t - 2 && x.t <= ev.t + ev.duration + 15);
  const snap = during || s[nearest(s, ev.t)];
  if (!snap || Math.abs(snap.t - ev.t) > 120) return null;
  return isShare(snap.file) ? `thumbs/${snap.file.slice('share/'.length)}` : snap.file;
}

function eventsShown() {
  return shown()
    .flatMap((c) => (C.days[c.slug]?.events || []).map((e, i) => ({ ...e, slug: c.slug, i })))
    .sort((a, b) => b.t - a.t);
}

function renderEvents() {
  const evs = eventsShown();
  const playing = new Set(C.panels.map((p) => p.clip?.file).filter(Boolean));
  $('camCount').textContent = evs.length ? `${evs.length} on ${dayLabel(C.date)}` : '';
  $('camEvents').innerHTML = evs.length
    ? evs.map((e) => {
        const thumb = thumbFor(e);
        return `<li><button class="ev ${e.kind} ${playing.has(e.file) ? 'on' : ''}" data-slug="${esc(e.slug)}" data-i="${e.i}">
          <span class="ev-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async">` : ''}<span class="ev-dur">${fmtDur(e.duration)}</span></span>
          <span class="ev-meta"><b><i class="ev-dot"></i>${fmtClock(e.t)}</b><small>${esc(camBy(e.slug)?.name ?? '')}${e.kind === 'ding' ? ' · Doorbell' : ''}</small></span></button></li>`;
      }).join('')
    : `<li class="empty">No events on ${dayLabel(C.date)}.</li>`;
}

/* ================= loading ================= */

async function loadDay({ keepPlace = false } = {}) {
  const date = C.date;
  const list = shown();
  const results = await Promise.all(list.map((c) => ctx.api(`api/cameras/${c.slug}/days/${date}`).catch(() => ({ snapshots: [], events: [] }))));
  if (date !== C.date) return;
  C.days = Object.fromEntries(list.map((c, i) => [c.slug, results[i]]));
  renderPanels();
  renderEvents();
  for (const p of C.panels) {
    renderTimeline(p);
    if (p.mode !== 'frame' || p.playing) { renderControls(p); continue; }
    const s = stills(p);
    if (keepPlace && p.pos >= 0 && p.pos < s.length - 2) { renderControls(p); continue; }
    // Today opens on the latest still (and follows it); past days open at the first one.
    if (!s.length) showEmpty(p);
    else showFrame(p, date === isoDay(new Date()) ? s.length - 1 : 0);
  }
}

async function loadDayLists() {
  const lists = await Promise.all(C.cams.map((c) => ctx.api(`api/cameras/${c.slug}/days`).then((r) => r.days).catch(() => [])));
  C.dayLists = Object.fromEntries(C.cams.map((c, i) => [c.slug, lists[i]]));
  renderDayNav();
}

function oldestDay() {
  const all = shown().flatMap((c) => C.dayLists[c.slug] || []);
  return all.length ? all.reduce((a, b) => (a < b ? a : b)) : null;
}

function renderDayNav() {
  const today = isoDay(new Date());
  const min = oldestDay();
  $('camDate').value = C.date;
  $('camDate').max = today;
  if (min) $('camDate').min = min; else $('camDate').removeAttribute('min');
  $('camPrev').disabled = Boolean(min && C.date <= min);
  $('camNext').disabled = C.date >= today;
}

function setDate(iso, { yest = false } = {}) {
  const today = isoDay(new Date());
  C.date = iso > today ? today : iso;
  C.yest = yest;
  for (const p of C.panels) {
    resetStage(p);
    p.mode = 'frame';
    p.pos = -1;
  }
  renderDayNav();
  renderBar();
  return loadDay();
}

function shiftDay(n) {
  const [y, m, d] = C.date.split('-').map(Number);
  setDate(isoDay(new Date(y, m - 1, d + n)));
}

function renderPicker() {
  const opts = C.cams.length > 1 ? [{ slug: 'all', name: 'All' }, ...C.cams] : [];
  $('camPick').hidden = !opts.length;
  if (prefs.filter !== 'all' && !camBy(prefs.filter)) prefs.filter = 'all';
  $('camPick').innerHTML = opts.map((c) => `<button data-slug="${esc(c.slug)}" aria-pressed="${prefs.filter === c.slug}">${esc(c.name)}</button>`).join('');
}

async function refreshStatus() {
  let s;
  try {
    s = await ctx.api('api/cameras/status');
  } catch {
    $('camStatus').className = 'cam-status bad';
    $('camStatus').textContent = 'Offline';
    $('camStatus').title = "Can't reach Portal's server";
    return false;
  }
  const before = C.cams.map((c) => c.slug).join();
  C.cams = s.cameras;
  C.mqtt = s.mqtt;
  C.summary = s.summary;
  const rec = C.cams.filter((c) => c.recording);
  const issues = [];
  if (C.cams.some((c) => c.kind === 'ring') && !s.mqtt) issues.push('Not connected to ring-mqtt');
  for (const c of C.cams) {
    if (c.online === false) issues.push(`${c.name} is offline`);
    if (c.error) issues.push(`${c.name}: ${c.error}`);
  }
  if (s.summary?.error) issues.push(s.summary.error);
  $('camStatus').className = `cam-status ${rec.length ? 'rec' : issues.length ? 'bad' : 'ok'}`;
  $('camStatus').textContent = rec.length ? `Recording ${rec.map((c) => c.name).join(', ')}` : issues.length ? 'Problem' : '';
  $('camStatus').title = issues.join('\n') || 'All cameras OK';
  const changed = C.cams.map((c) => c.slug).join() !== before;
  if (changed) { renderPicker(); loadDayLists(); }
  C.panels.forEach(renderControls);
  renderBar();
  return changed;
}

/* ================= wiring ================= */

function wireVideo(p) {
  const v = p.video;
  v.addEventListener('timeupdate', () => {
    if (p.mode === 'clip' && p.clip) setCursor(p, p.clip.t + v.currentTime);
    else if (p.mode === 'summary') followSummary(p);
  });
  v.addEventListener('loadedmetadata', () => { if (p.mode === 'summary') followSummary(p); });
  // Clips play on through the rest of the camera's day, oldest to newest, like a playlist.
  v.addEventListener('ended', () => {
    if (p.mode !== 'clip' || !p.clip) return;
    if (p.lapse != null) return resumeTimelapse(p);
    const next = nextClip(p, p.clip);
    if (next) playClip(p, { ...next, slug: p.slug });
  });
  v.addEventListener('play', () => renderControls(p));
  v.addEventListener('pause', () => renderControls(p));
  v.addEventListener('volumechange', () => { prefs.muted = v.muted; savePrefs(); });
  // A browser without HEVC may play the audio over a blank picture rather than fail outright.
  v.addEventListener('loadeddata', () => {
    if (p.mode !== 'clip' || !isShare(p.clip.file) || v.videoWidth) return;
    p.lapse != null ? resumeTimelapse(p) : hevcNotice(p, p.clip);
  });
  v.addEventListener('error', () => {
    if (p.mode !== 'clip' || !p.clip || !v.getAttribute('src')) return;
    if (p.lapse != null) return resumeTimelapse(p);
    if (isShare(p.clip.file)) hevcNotice(p, p.clip);
    else showNotice(p, `<p>Couldn't play this clip.</p><p><button class="btn" data-act="back">Back to timeline</button></p>`);
  });
}

function wire() {
  $('camPick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-slug]');
    if (!b) return;
    prefs.filter = b.dataset.slug;
    savePrefs();
    renderPicker();
    renderDayNav();
    setDate(C.date);
  });
  $('camPrev').onclick = () => shiftDay(-1);
  $('camNext').onclick = () => shiftDay(1);
  $('camDate').onchange = () => $('camDate').value && setDate($('camDate').value);
  $('camYest').onclick = () => (C.yest ? leaveYesterday() : showYesterday());

  const box = $('camPanels');
  const panelOf = (el) => panelFor(el.closest('.cam-panel')?.dataset.slug);
  box.addEventListener('click', (e) => {
    const p = panelOf(e.target);
    if (!p) return;
    setFocus(p);
    const r = e.target.closest('[data-r]');
    if (r) return setRate(p, +r.dataset.r);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') togglePlay(p);
    else if (act === 'live') p.mode === 'live' ? backToTimeline(p) : startLive(p);
    else if (act === 'back') backToTimeline(p);
    else if (act === 'force' && p.clip) playClip(p, p.clip, true);
    else if (act === 'yesterday') summaryFor(p) ? showSummary(p) : showYesterday();
  });
  box.addEventListener('pointerdown', (e) => {
    const lane = e.target.closest('.lane');
    const p = lane && panelOf(lane);
    if (!p) return;
    setFocus(p);
    const mark = e.target.closest('b[data-i]');
    // On the summary, the lane seeks it instead.
    if (mark && p.mode !== 'summary') return playClip(p, { ...C.days[p.slug].events[+mark.dataset.i], slug: p.slug });
    dragging = p;
    lane.setPointerCapture(e.pointerId);
    stopTimelapse(p);
    scrubTo(p, e.clientX);
  });
  box.addEventListener('pointermove', (e) => { if (dragging) scrubTo(dragging, e.clientX); });
  box.addEventListener('pointerup', () => (dragging = null));
  box.addEventListener('pointercancel', () => (dragging = null));

  $('camEvents').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    const p = b && panelFor(b.dataset.slug);
    if (!p) return;
    setFocus(p);
    playClip(p, { ...C.days[p.slug].events[+b.dataset.i], slug: p.slug });
    // The list sits below the stages; bring the one now playing back into view.
    p.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  window.addEventListener('pagehide', () => C.panels.forEach(stopLive));
}

/* ================= public ================= */

export function initCameras(helpers) {
  ctx = helpers;
}

export async function showCameras() {
  if (!C.ready) { C.ready = true; wire(); }
  C.visible = true;
  renderDayNav();
  await refreshStatus();
  renderPicker();
  loadDayLists();
  await loadDay({ keepPlace: true });
  C.timers.forEach(clearInterval);
  C.timers = [
    setInterval(async () => { if (!document.hidden && (await refreshStatus())) loadDay(); }, 15_000),
    // Today keeps growing; pick up new stills and events without losing your place.
    setInterval(() => { if (!document.hidden && C.date === isoDay(new Date())) loadDay({ keepPlace: true }); }, 30_000),
  ];
}

export function hideCameras() {
  C.visible = false;
  C.timers.forEach(clearInterval);
  C.timers = [];
  for (const p of C.panels) {
    stopTimelapse(p);
    stopLive(p);
    p.video.pause();
    if (p.mode === 'live') p.mode = 'frame';
  }
}

/** Keys while the Cameras tab is showing. Returns true when it handled the key. They act on the
 * panel last touched. */
export function cameraKey(e) {
  const p = C.focus;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (!p) return false;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    const v = p.video;
    if (isVideo(p)) v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + dir * (e.shiftKey ? 30 : 10)));
    else if (p.mode === 'frame') { stopTimelapse(p); showFrame(p, p.pos + dir * (e.shiftKey ? 10 : 1)); }
  } else if (e.key === ' ') { if (p) togglePlay(p); }
  else if (e.key === '[') shiftDay(-1);
  else if (e.key === ']') { if (!$('camNext').disabled) shiftDay(1); }
  else if (e.key === 'l' || e.key === 'L') {
    const t = liveTarget();
    if (t) t.mode === 'live' ? backToTimeline(t) : startLive(t);
  } else if (e.key === 'y' || e.key === 'Y') $('camYest').hidden || $('camYest').click();
  else if (e.key === 'Escape') {
    const busy = C.panels.filter((q) => q.mode !== 'frame');
    if (!busy.length) return false;
    busy.forEach(backToTimeline);
  } else return false;
  e.preventDefault();
  return true;
}

/* ================= settings tab ================= */

const num = (name, value, min, max) => `<input class="field num" type="number" name="${name}" value="${value}" min="${min}" max="${max}" required>`;

export async function cameraSettings(P) {
  P.innerHTML = '<p class="note" style="margin:0">Loading camera settings…</p>';
  let s;
  try {
    s = await ctx.api('api/cameras/settings');
  } catch (err) {
    P.innerHTML = `<p class="err">Couldn't load camera settings: ${esc(err.message)}</p>`;
    return;
  }
  if (!P.isConnected) return;
  const u = s.usage;
  const used = (slug) => (u?.cameras[slug] ? ` · ${fmtBytes(u.cameras[slug].clips)} clips, ${fmtBytes(u.cameras[slug].snapshots)} stills` : '');
  const ring = Object.entries(s.cameras);
  const reo = Object.entries(s.reolink.cameras);
  P.innerHTML = `<form id="camSet" style="display:flex;flex-direction:column;gap:22px">
    <section><h3>Ring</h3>
      <div class="list">${ring.map(([id, c]) => `<div class="li"><input type="checkbox" class="switch" data-ring="${esc(id)}" data-f="enabled" ${c.enabled ? 'checked' : ''} aria-label="Record ${esc(c.name)}">
        <span class="grow"><input class="field" data-ring="${esc(id)}" data-f="name" value="${esc(c.name)}" maxlength="60" required aria-label="Camera name"><small>${esc(c.slug)}/${used(c.slug)}</small></span></div>`).join('')
        || '<div class="li"><span class="grow note" style="margin:0">None yet. They appear once ring-mqtt reports them.</span></div>'}</div>
      <div class="setrows">
        <label class="row"><span>Keep snapshots</span><span>${num('snapshotDays', s.snapshotDays, 1, 365)} days</span></label>
        <label class="row"><span>Keep event clips</span><span>${num('eventDays', s.eventDays, 1, 730)} days</span></label>
        <label class="row"><span>Snapshot every</span><span>${num('snapshotInterval', s.snapshotInterval, 10, 600)} sec</span></label>
        <label class="row"><span>Record per event</span><span>${num('clipLength', s.clipLength, 15, 300)} sec</span></label>
      </div>
      <p class="note">Ring takes the snapshots and may not honor very short intervals. A doorbell press extends a clip. Live view pauses Ring's motion events, so nothing records while it's open.</p></section>
    <section><h3>Reolink</h3>
      <div class="list">${reo.map(([prefix, c]) => `<div class="li"><span class="grow"><input class="field" data-reo="${esc(prefix)}" value="${esc(c.name)}" maxlength="60" required aria-label="Camera name"><small>${esc(prefix)}_… uploads${used(c.slug)}</small></span></div>`).join('')
        || '<div class="li"><span class="grow note" style="margin:0">None yet. They appear once they upload to the share.</span></div>'}</div>
      <div class="setrows">
        <label class="row"><span>Keep clips and stills</span><span>${num('clipDays', s.reolink.clipDays, 2, 730)} days</span></label>
        <label class="row"><span>Keep daily summaries</span><span>${num('summaryDays', s.reolink.summaryDays, 2, 730)} days${u ? ` · ${fmtBytes(u.summaries)}` : ''}</span></label>
      </div>
      <p class="note">Retention only deletes files on the NAS. The camera's own storage is untouched. Two days is the minimum, so the daily summary can always be built from yesterday's clips.</p></section>
    <div><button class="btn primary" id="camSave">Save</button> <span class="note" id="camUsageAt">${u ? `Disk use measured ${new Date(u.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'Measuring disk use…'}</span>
      <p class="err" id="camSetErr" hidden></p></div>
  </form>`;

  $('camSet').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const next = structuredClone(s);
    delete next.usage;
    for (const k of ['snapshotDays', 'eventDays', 'snapshotInterval', 'clipLength']) next[k] = Number(f.elements[k].value);
    for (const k of ['clipDays', 'summaryDays']) next.reolink[k] = Number(f.elements[k].value);
    for (const el of f.querySelectorAll('[data-ring]')) next.cameras[el.dataset.ring][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value.trim();
    for (const el of f.querySelectorAll('[data-reo]')) next.reolink.cameras[el.dataset.reo].name = el.value.trim();
    $('camSave').disabled = true;
    try {
      s = await ctx.api('api/cameras/settings', { method: 'PUT', body: JSON.stringify(next) });
      ctx.toast('Camera settings saved', false);
      $('camSetErr').hidden = true;
      if (C.visible) {
        await refreshStatus();
        renderPicker(); // names may have changed
        loadDay({ keepPlace: true });
      }
    } catch (err) {
      $('camSetErr').textContent = err.message;
      $('camSetErr').hidden = false;
    } finally {
      if ($('camSave')) $('camSave').disabled = false;
    }
  };
}
