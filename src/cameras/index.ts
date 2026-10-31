import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { FastifyInstance } from 'fastify';
import { DayIndex, dayIndex, expired, listDays, sweep } from './library';
import { LiveView } from './live';
import { DAY_RE, dayPath, slugify } from './paths';
import { PeopleCounter } from './people';
import { ClipRecorder } from './recorder';
import { Usage, discoverPrefixes, measure, parseReolink, reolinkDay, reolinkDays, sweepShare } from './reolink';
import { RingBridge } from './ring';
import { SettingsStore } from './settings';
import { SnapshotWriter } from './snapshots';
import { CameraService, run } from './summary';

/**
 * The Cameras tab: the Ring recorder (formerly Sentry), the Reolink's SFTP uploads, the daily
 * summary, and retention for all of them.
 *
 * URLs: Ring footage under `footage/`, the share's own files under `share/`, live HLS under
 * `live/`, the converted daily summary under `media/`.
 */

interface Options {
  /** the SecurityCameras share */
  shareRoot: string;
  /** Ring footage, `<share>/Sentry` on the NAS */
  footageRoot: string;
  dataDir: string;
  mqttUrl: string;
  rtspBase: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

interface Live {
  recorder: ClipRecorder;
  online: boolean | null;
  snapshotConfig: { mode?: string; interval?: number };
}

const fallbackName = (id: string) => `Ring camera ${id.slice(-4)}`;

const readdirSafe = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Runs at most `n` jobs at once; the NAS is a 4-core Atom that is also recording. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
const limit = limiter(2);

const probe = async (file: string) =>
  Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim());

export function cameras(app: FastifyInstance, opts: Options) {
  const { shareRoot, footageRoot, dataDir, log } = opts;
  const rtspBase = opts.rtspBase.replace(/\/$/, '');

  fs.mkdirSync(footageRoot, { recursive: true });
  const settings = new SettingsStore(path.join(dataDir, 'cameras.json'), log);
  const ring = new RingBridge(opts.mqttUrl, log);
  const snapshots = new SnapshotWriter(footageRoot);
  const liveView = new LiveView(path.join(dataDir, 'live'), log);
  const summary = new CameraService(shareRoot, path.join(dataDir, 'camera'), log);
  const reolinkCache = path.join(dataDir, 'reolink');
  const thumbDir = path.join(dataDir, 'thumbs');
  const people = new PeopleCounter({
    footageRoot,
    dir: path.join(dataDir, 'people'),
    model: path.join(__dirname, '..', '..', 'models', 'yolox_nano.onnx'),
    slugs: () => Object.values(settings.get().cameras).filter((c) => c.enabled).map((c) => c.slug),
    log,
  });
  const live = new Map<string, Live>();
  let usage: Usage | null = null;
  let measuring = false;

  function liveFor(id: string): Live {
    let entry = live.get(id);
    if (!entry) {
      entry = {
        online: null,
        snapshotConfig: {},
        recorder: new ClipRecorder({
          root: footageRoot,
          slug: () => settings.get().cameras[id]?.slug ?? id,
          rtspUrl: `${rtspBase}/${id}_live`,
          clipLength: () => settings.get().clipLength,
          log,
        }),
      };
      live.set(id, entry);
    }
    return entry;
  }

  const enabled = (id: string) => settings.get().cameras[id]?.enabled ?? false;

  ring.on('camera', (id, location, name) => {
    const known = settings.get().cameras[id];
    if (!known) {
      const label = name ?? fallbackName(id);
      const cam = settings.addCamera(id, { name: label, slug: slugify(label), location });
      log.info(`New camera ${cam.name} (${id}) → ${cam.slug}/`);
    } else if (name && known.name === fallbackName(id)) {
      // Seen by its state topics first; take the real name, and the slug too if nothing's on disk yet.
      const patch = listDays(footageRoot, known.slug).length ? { name } : { name, slug: slugify(name) };
      settings.updateCamera(id, patch);
    }
    liveFor(id);
    ring.setSnapshots(id, location, settings.get().snapshotInterval);
  });

  ring.on('motion', (id, on) => enabled(id) && liveFor(id).recorder.motion(on));
  ring.on('ding', (id, on) => enabled(id) && liveFor(id).recorder.ding(on));
  ring.on('online', (id, online) => (liveFor(id).online = online));
  ring.on('snapshotConfig', (id, c) => Object.assign(liveFor(id).snapshotConfig, c));
  ring.on('snapshot', (id, jpeg) => {
    const cam = settings.get().cameras[id];
    if (!cam?.enabled) return;
    try {
      snapshots.save(cam.slug, jpeg);
    } catch (err) {
      log.warn(`${cam.slug}: couldn't save snapshot: ${(err as Error).message}`);
    }
  });

  /** Adds any Reolink filename prefix seen on the share that isn't a camera yet. */
  function discoverReolink() {
    try {
      for (const prefix of discoverPrefixes(shareRoot)) {
        if (settings.get().reolink.cameras[prefix]) continue;
        const cam = settings.addReolink(prefix, slugify(prefix));
        log.info(`New Reolink camera ${prefix} → ${cam.slug}`);
      }
    } catch (err) {
      log.warn(`Couldn't scan the camera share: ${(err as Error).message}`);
    }
  }

  function refreshUsage() {
    if (measuring) return;
    measuring = true;
    const s = settings.get();
    measure(shareRoot, footageRoot, Object.values(s.cameras), s.reolink.cameras)
      .then((u) => (usage = u))
      .catch((err) => log.warn(`Couldn't measure disk use: ${(err as Error).message}`))
      .finally(() => (measuring = false));
  }

  function runRetention() {
    discoverReolink();
    const s = settings.get();
    for (const cam of Object.values(s.cameras)) {
      try {
        const n = sweep(footageRoot, cam.slug, s);
        if (n) log.info(`${cam.slug}: retention removed ${n} folder(s)`);
      } catch (err) {
        log.warn(`${cam.slug}: retention failed: ${(err as Error).message}`);
      }
    }
    try {
      const n = sweepShare(shareRoot, Object.keys(s.reolink.cameras), s.reolink);
      if (n) log.info(`Camera share: retention removed ${n} file(s)`);
    } catch (err) {
      log.warn(`Camera share: retention failed: ${(err as Error).message}`);
    }
    // Thumbnails and cached clip lengths follow their footage out.
    for (const day of expired(listDays(thumbDir, ''), s.reolink.clipDays)) {
      fs.rmSync(path.join(thumbDir, dayPath('', day)), { recursive: true, force: true });
    }
    people.sweep((days) => expired(days, s.eventDays));
    for (const name of readdirSafe(reolinkCache)) {
      const day = name.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
      if (day && expired([day], s.reolink.clipDays).length) fs.rmSync(path.join(reolinkCache, name), { force: true });
    }
    refreshUsage();
  }

  // Finished footage never changes (in-progress files are .part and aren't linked anywhere).
  for (const [root, prefix] of [[footageRoot, '/footage/'], [shareRoot, '/share/']]) {
    app.register(fastifyStatic, { root, prefix, decorateReply: false, maxAge: '7d', immutable: true });
  }
  // Converted summaries are named per conversion, so they can be cached for good.
  app.register(fastifyStatic, { root: summary.outDir, prefix: '/media/', decorateReply: false, maxAge: '7d', immutable: true });
  // The live playlist rewrites every couple of seconds, so it must never be cached.
  app.register(fastifyStatic, {
    root: liveView.dir,
    prefix: '/live/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  });

  type Cam = { kind: 'ring'; id: string; slug: string } | { kind: 'reolink'; prefix: string; slug: string };
  function camBySlug(slug: string): Cam | null {
    const s = settings.get();
    const r = Object.entries(s.cameras).find(([, c]) => c.slug === slug);
    if (r) return { kind: 'ring', id: r[0], slug };
    const o = Object.entries(s.reolink.cameras).find(([, c]) => c.slug === slug);
    return o ? { kind: 'reolink', prefix: o[0], slug } : null;
  }

  app.get('/api/cameras/status', async () => {
    const s = settings.get();
    const st = summary.status();
    return {
      mqtt: ring.connected,
      cameras: [
        ...Object.entries(s.cameras)
          .filter(([, cam]) => cam.enabled)
          .map(([id, cam]) => {
            const l = live.get(id);
            return {
              kind: 'ring',
              slug: cam.slug,
              name: cam.name,
              canLive: true,
              online: l?.online ?? null,
              ringSnapshots: l?.snapshotConfig ?? {},
              recording: l?.recorder.recording ?? false,
              live: liveView.isLive(cam.slug),
              lastEvent: l?.recorder.lastEvent ?? null,
              lastSnapshot: snapshots.lastAt.get(cam.slug) ?? null,
              error: l?.recorder.lastError ?? null,
            };
          }),
        ...Object.values(s.reolink.cameras).map((cam) => ({ kind: 'reolink', slug: cam.slug, name: cam.name, canLive: false })),
      ],
      summary: st.state
        ? {
            date: st.state.date,
            duration: st.state.duration,
            video: `media/${st.state.video}`,
            poster: `media/${st.state.poster}`,
            processing: st.processing,
            error: st.error,
          }
        : { none: true, processing: st.processing, error: st.error },
      counting: people.current,
    };
  });

  app.get('/api/cameras/settings', async () => ({ ...settings.get(), usage }));
  app.put('/api/cameras/settings', async (req) => {
    const before = settings.get().snapshotInterval;
    const next = settings.set(req.body);
    if (next.snapshotInterval !== before) {
      for (const [id, cam] of Object.entries(next.cameras)) ring.setSnapshots(id, cam.location, next.snapshotInterval);
    }
    runRetention();
    return { ...next, usage };
  });

  app.get<{ Params: { slug: string } }>('/api/cameras/:slug/days', async (req, reply) => {
    const cam = camBySlug(req.params.slug);
    if (!cam) return reply.status(404).send({ error: 'No such camera' });
    return { days: cam.kind === 'ring' ? listDays(footageRoot, cam.slug) : reolinkDays(shareRoot, cam.prefix) };
  });

  app.get<{ Params: { slug: string; date: string } }>('/api/cameras/:slug/days/:date', async (req, reply) => {
    const cam = camBySlug(req.params.slug);
    if (!cam) return reply.status(404).send({ error: 'No such camera' });
    const { date } = req.params;
    if (!DAY_RE.test(date)) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    const [base, day]: [string, DayIndex] =
      cam.kind === 'ring'
        ? ['footage/', dayIndex(footageRoot, cam.slug, date)]
        : ['share/', await reolinkDay(shareRoot, cam.prefix, date, probe, reolinkCache)];
    const counted = cam.kind === 'ring' && people.available ? people.forDay(cam.slug, date, day.events) : null;
    return {
      date,
      snapshots: day.snapshots.map((x) => ({ ...x, file: base + x.file })),
      events: day.events.map((x) => ({ ...x, file: base + x.file, ...(counted && { people: counted.byFile[x.file] }) })),
      ...(counted && { people: { total: counted.total, pending: counted.pending } }),
    };
  });

  // Small copies of the Reolink's 4K stills for the event list, made on first request and kept in
  // the data volume (never on the share) until retention drops their day.
  const thumbJobs = new Map<string, Promise<void>>();
  app.get<{ Params: { '*': string } }>('/thumbs/*', async (req, reply) => {
    const rel = req.params['*'];
    if (!/^\d{4}\/\d{2}\/\d{2}\/[^/]+\.jpg$/.test(rel) || !parseReolink(path.basename(rel))) {
      return reply.status(404).send({ error: 'Not a camera still' });
    }
    const out = path.join(thumbDir, rel);
    if (!fs.existsSync(out)) {
      const src = path.join(shareRoot, rel);
      if (!fs.existsSync(src)) return reply.status(404).send({ error: 'No such still' });
      let job = thumbJobs.get(rel);
      if (!job) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = `${out}.part.jpg`;
        job = limit(() => run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'scale=480:-2', '-q:v', '5', '-frames:v', '1', tmp]))
          .then(() => fs.renameSync(tmp, out))
          .finally(() => thumbJobs.delete(rel));
        thumbJobs.set(rel, job);
      }
      await job;
    }
    return reply.type('image/jpeg').header('Cache-Control', 'public, max-age=604800, immutable').send(fs.createReadStream(out));
  });

  // Live view (Ring only): the page POSTs every few seconds while it's open, and DELETEs when it closes.
  app.post<{ Params: { slug: string } }>('/api/cameras/:slug/live', async (req, reply) => {
    const cam = camBySlug(req.params.slug);
    if (cam?.kind !== 'ring') return reply.status(404).send({ error: 'This camera has no live view' });
    const s = liveView.ping(cam.slug, `${rtspBase}/${cam.id}_live`);
    return { ...s, playlist: `live/${s.playlist}` };
  });
  app.delete<{ Params: { slug: string } }>('/api/cameras/:slug/live', async (req) => {
    liveView.stop(req.params.slug);
    return { ok: true };
  });

  return {
    get mqtt() {
      return ring.connected;
    },
    start() {
      ring.start();
      summary.start();
      people.start();
      runRetention();
      setInterval(runRetention, 3600_000).unref();
    },
    async shutdown() {
      ring.stop();
      people.stop();
      liveView.stopAll();
      await Promise.all([...live.values()].map((l) => l.recorder.shutdown()));
    },
  };
}
