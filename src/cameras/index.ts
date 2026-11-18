import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { FastifyInstance } from 'fastify';
import { expired, listDays } from './library';
import { LiveView } from './live';
import { DAY_RE, FOLDER_RE, dayPath, slugify } from './paths';
import { Usage, discoverPrefixes, measure, parseReolink, reolinkDay, reolinkDays, sweepShare, uploadFolders } from './reolink';
import { Camera, SettingsStore, publicSettings, rtspForFfmpeg } from './settings';
import { SummaryBuilder, SummaryCamera, findSummary, run } from './summaries';

/**
 * The Cameras tab: the Reolinks' FTP uploads on the SecurityCameras share (one folder per
 * camera), a daily summary per camera that Portal builds, RTSP live view, and retention.
 * The Ring doorbell (and with it ring-mqtt, recording and people counting) was removed on
 * 2026-11-18, when a Reolink doorbell replaced it.
 *
 * URLs: the share's files under `share/`, live HLS under `live/`, still thumbnails under `thumbs/`.
 */

interface Options {
  /** the SecurityCameras share */
  shareRoot: string;
  dataDir: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** Share folders that aren't a camera's: Synology's recycle bin and index folders don't match FOLDER_RE. */
const NOT_CAMERAS = ['Sentry'];

const readdirSafe = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Runs at most `n` jobs at once; the NAS is a 4-core Atom. */
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

const probe = async (file: string) => {
  const out = JSON.parse(
    await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', file]),
  );
  return { duration: Number(out.format?.duration) || 0, codec: String(out.streams?.[0]?.codec_name ?? '') };
};

export function cameras(app: FastifyInstance, opts: Options) {
  const { shareRoot, dataDir, log } = opts;

  const settings = new SettingsStore(path.join(dataDir, 'cameras.json'), log);
  const liveView = new LiveView(path.join(dataDir, 'live'), log);
  const reolinkCache = path.join(dataDir, 'reolink');
  const thumbDir = path.join(dataDir, 'thumbs');
  const rootOf = (cam: Camera) => path.join(shareRoot, cam.folder);
  const summaryCams = (): SummaryCamera[] =>
    Object.entries(settings.get().cameras).map(([prefix, c]) => ({ prefix, slug: c.slug, root: rootOf(c) }));
  const summaries = new SummaryBuilder({
    cameras: summaryCams,
    probe,
    cacheDir: reolinkCache,
    tmpDir: path.join(dataDir, 'summary-tmp'),
    log,
  });
  let usage: Usage | null = null;
  let measuring = false;
  let started = false;

  // Left behind by the Ring recorder, the people counter and the old summary converter.
  for (const old of ['camera', 'people']) fs.rmSync(path.join(dataDir, old), { recursive: true, force: true });

  /** Camera folders on the share, plus '' (the top level: the layout before 2026-11-18). */
  const folders = () => ['', ...uploadFolders(shareRoot, NOT_CAMERAS)];

  /**
   * Adds any filename prefix seen on the share that isn't a camera yet, and follows a camera whose
   * uploads moved to another folder (its old folder has none of its files left).
   */
  function discover() {
    let changed = false;
    try {
      const seen = new Map<string, string[]>();
      for (const folder of folders()) {
        for (const prefix of discoverPrefixes(path.join(shareRoot, folder))) seen.set(prefix, [...(seen.get(prefix) ?? []), folder]);
      }
      for (const [prefix, where] of seen) {
        const known = settings.get().cameras[prefix];
        // Prefer the camera's own folder over the old top level.
        const folder = where.find((f) => f === prefix) ?? where.find((f) => f !== '') ?? '';
        if (!known) {
          const cam = settings.addCamera(prefix, slugify(prefix), folder);
          log.info(`New camera ${prefix}${folder ? ` in ${folder}/` : ''} → ${cam.slug}`);
          changed = true;
        } else if (!where.includes(known.folder)) {
          settings.moveCamera(prefix, folder);
          log.info(`${known.slug}: uploads moved from ${known.folder || 'the top level'} to ${folder || 'the top level'}/`);
          changed = true;
        }
      }
    } catch (err) {
      log.warn(`Couldn't scan the camera share: ${(err as Error).message}`);
    }
    // A new or moved camera gets its recent summaries without waiting for the next pass.
    if (changed && started) void summaries.check();
  }

  function refreshUsage() {
    if (measuring) return;
    measuring = true;
    measure(shareRoot, settings.get().cameras)
      .then((u) => (usage = u))
      .catch((err) => log.warn(`Couldn't measure disk use: ${(err as Error).message}`))
      .finally(() => (measuring = false));
  }

  function runRetention() {
    discover();
    const s = settings.get();
    const cams = Object.entries(s.cameras);
    // Each folder is swept for its own cameras' files only.
    for (const folder of new Set(['', ...cams.map(([, c]) => c.folder)])) {
      const where = folder ? `${folder}/` : 'Share top level';
      try {
        const prefixes = cams.filter(([, c]) => c.folder === folder).map(([p]) => p);
        const n = sweepShare(path.join(shareRoot, folder), prefixes, s.clipDays);
        if (n) log.info(`${where}: retention removed ${n} file(s)`);
      } catch (err) {
        log.warn(`${where}: retention failed: ${(err as Error).message}`);
      }
      // Thumbnails follow their footage out.
      for (const day of expired(listDays(thumbDir, folder), s.clipDays)) {
        fs.rmSync(path.join(thumbDir, dayPath(folder, day)), { recursive: true, force: true });
      }
    }
    for (const cam of summaryCams()) {
      try {
        const n = summaries.sweep(cam, s.summaryDays);
        if (n) log.info(`${cam.slug}: retention removed ${n} summary file(s)`);
      } catch (err) {
        log.warn(`${cam.slug}: summary retention failed: ${(err as Error).message}`);
      }
    }
    for (const name of readdirSafe(reolinkCache)) {
      const day = name.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
      if (day && expired([day], s.clipDays).length) fs.rmSync(path.join(reolinkCache, name), { force: true });
    }
    refreshUsage();
  }

  // Finished footage and summaries never change (summaries are named per build).
  app.register(fastifyStatic, { root: shareRoot, prefix: '/share/', decorateReply: false, maxAge: '7d', immutable: true });
  // The live playlist rewrites every couple of seconds, so it must never be cached.
  app.register(fastifyStatic, {
    root: liveView.dir,
    prefix: '/live/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  });

  function camBySlug(slug: string): (Camera & { prefix: string }) | null {
    const o = Object.entries(settings.get().cameras).find(([, c]) => c.slug === slug);
    return o ? { ...o[1], prefix: o[0] } : null;
  }
  /** URL prefix for a camera's files, which are relative to its folder. */
  const base = (cam: Camera) => (cam.folder ? `share/${cam.folder}/` : 'share/');

  app.get('/api/cameras/status', async () => {
    const s = settings.get();
    return {
      cameras: Object.values(s.cameras).map((cam) => ({
        kind: 'reolink',
        slug: cam.slug,
        name: cam.name,
        canLive: Boolean(cam.rtsp),
        live: liveView.isLive(cam.slug),
      })),
      summary: { building: summaries.busy, error: summaries.lastError },
    };
  });

  app.get('/api/cameras/settings', async () => ({ ...publicSettings(settings.get()), usage }));
  app.put('/api/cameras/settings', async (req) => {
    const next = settings.set(req.body);
    // A changed RTSP URL takes effect on the next live session.
    for (const cam of Object.values(next.cameras)) if (!cam.rtsp) liveView.stop(cam.slug);
    runRetention();
    // after retention's discovery, which may have moved a camera
    return { ...publicSettings(settings.get()), usage };
  });

  app.get<{ Params: { slug: string } }>('/api/cameras/:slug/days', async (req, reply) => {
    const cam = camBySlug(req.params.slug);
    if (!cam) return reply.status(404).send({ error: 'No such camera' });
    return { days: reolinkDays(rootOf(cam), cam.prefix) };
  });

  app.get<{ Params: { slug: string; date: string } }>('/api/cameras/:slug/days/:date', async (req, reply) => {
    const cam = camBySlug(req.params.slug);
    if (!cam) return reply.status(404).send({ error: 'No such camera' });
    const { date } = req.params;
    if (!DAY_RE.test(date)) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    const day = await reolinkDay(rootOf(cam), cam.prefix, date, probe, reolinkCache);
    const sum = findSummary({ prefix: cam.prefix, slug: cam.slug, root: rootOf(cam) }, date);
    const b = base(cam);
    return {
      date,
      snapshots: day.snapshots.map((x) => ({ ...x, file: b + x.file })),
      events: day.events.map((x) => ({ ...x, file: b + x.file })),
      summary: sum && { date, duration: sum.duration, video: b + sum.video, poster: b + sum.poster },
    };
  });

  // Small copies of the cameras' stills for the event list, made on first request and kept in
  // the data volume (never on the share) until retention drops their day.
  const thumbJobs = new Map<string, Promise<void>>();
  app.get<{ Params: { '*': string } }>('/thumbs/*', async (req, reply) => {
    const rel = req.params['*'];
    // <folder>/YYYY/MM/DD/<still>.jpg, or YYYY/MM/DD/<still>.jpg from the old top-level layout
    const m = rel.match(/^(?:([^/]+)\/)?\d{4}\/\d{2}\/\d{2}\/([^/]+\.jpg)$/);
    if (!m || (m[1] !== undefined && !FOLDER_RE.test(m[1])) || !parseReolink(m[2])) {
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

  // Live view (cameras with an RTSP URL): the page POSTs every few seconds while it's open, and
  // DELETEs when it closes.
  app.post<{ Params: { slug: string } }>('/api/cameras/:slug/live', async (req, reply) => {
    const cam = camBySlug(req.params.slug);
    if (!cam?.rtsp) return reply.status(404).send({ error: 'This camera has no live view' });
    const s = liveView.ping(cam.slug, rtspForFfmpeg(cam.rtsp));
    return { ...s, playlist: `live/${s.playlist}` };
  });
  app.delete<{ Params: { slug: string } }>('/api/cameras/:slug/live', async (req) => {
    liveView.stop(req.params.slug);
    return { ok: true };
  });

  return {
    start() {
      runRetention();
      setInterval(runRetention, 3600_000).unref();
      summaries.start();
      started = true;
    },
    async shutdown() {
      summaries.stop();
      liveView.stopAll();
    },
  };
}
