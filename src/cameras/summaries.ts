import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expired } from './library';
import { isoDay } from './paths';
import { Probe, readdir, reolinkDay } from './reolink';

/**
 * Daily summaries: each camera's clips for a day, back to back, as one ≤1080p H.264 video the
 * browser can play. Portal builds them itself (until 2026-11-18 a DSM scheduled task joined the
 * Driveway's clips and Portal converted the result). Written next to the camera's footage:
 *   <folder>/Summary/<Prefix>_<date>_<stamp>.mp4   the video (named per build, so it caches for good)
 *   <folder>/Summary/<Prefix>_<date>_<stamp>.jpg   its poster
 *   <folder>/Summary/<Prefix>_<date>.json          what's current, and the clips it was built from
 * A day is built once it's over (plus SETTLE for late uploads), and again if its clips change.
 * Only the last few days are built, so a missed night catches up without redoing months.
 */

/** Bump when the conversion changes, so existing summaries are rebuilt (within BACKFILL_DAYS). */
const FORMAT = 1;
const BACKFILL_DAYS = 3;
/** How long after midnight a day counts as finished: uploads from 23:59 have to land and settle. */
const SETTLE_MS = 30 * 60_000;

export interface SummaryMeta {
  format: number;
  /** the clips it joins, in order */
  clips: string[];
  video: string;
  poster: string;
  duration: number;
}

export interface SummaryCamera {
  prefix: string;
  slug: string;
  /** the camera's folder: `<share>/<folder>` */
  root: string;
}

export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').pop()}`)),
    );
  });
}

/** nice keeps the conversion from starving the NAS's other containers; it's a 4-core Atom. */
const niced = (args: string[]) => (process.platform === 'win32' ? run(args[0], args.slice(1)) : run('nice', ['-n', '15', ...args]));

const summaryDir = (cam: SummaryCamera) => path.join(cam.root, 'Summary');
const metaFile = (cam: SummaryCamera, date: string) => path.join(summaryDir(cam), `${cam.prefix}_${date}.json`);
const META_RE = /^(.+)_(\d{4}-\d{2}-\d{2})\.json$/;

/** The current summary for a camera's day, if one has been built. Paths are relative to `cam.root`. */
export function findSummary(cam: SummaryCamera, date: string): SummaryMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(cam, date), 'utf8'));
  } catch {
    return null;
  }
}

/** Days that should have a summary by `now`: the last BACKFILL_DAYS finished ones, newest first. */
export function dueDays(now = new Date()): string[] {
  const ready = new Date(now.getTime() - SETTLE_MS);
  return Array.from({ length: BACKFILL_DAYS }, (_, i) =>
    isoDay(new Date(ready.getFullYear(), ready.getMonth(), ready.getDate() - 1 - i)),
  );
}

/** `file '…'` lines for ffmpeg's concat demuxer. */
export const concatList = (files: string[]) => files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';

export class SummaryBuilder {
  busy: { slug: string; date: string } | null = null;
  lastError: string | null = null;
  /** clip lists that failed to build, so a broken day isn't retried every pass */
  private failed = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private opts: {
      cameras: () => SummaryCamera[];
      probe: Probe;
      cacheDir: string;
      tmpDir: string;
      log: { info: (msg: string) => void; warn: (msg: string) => void };
    },
  ) {
    fs.rmSync(opts.tmpDir, { recursive: true, force: true });
  }

  start(everyMs = 10 * 60_000) {
    this.check();
    this.timer = setInterval(() => this.check(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async check(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.checkAll(now);
    } finally {
      this.running = false;
    }
  }

  private async checkAll(now: Date) {
    for (const cam of this.opts.cameras()) {
      for (const date of dueDays(now)) {
        try {
          await this.ensure(cam, date);
        } catch (err) {
          const msg = `${cam.slug}: couldn't build the summary for ${date}: ${(err as Error).message}`;
          this.lastError = msg;
          this.opts.log.warn(msg);
        } finally {
          this.busy = null;
        }
      }
    }
  }

  /** Builds (or rebuilds) one day's summary if its clips changed since the last build. */
  async ensure(cam: SummaryCamera, date: string): Promise<boolean> {
    const day = await reolinkDay(cam.root, cam.prefix, date, this.opts.probe, this.opts.cacheDir);
    const clips = day.events.map((e) => e.file);
    const expected = day.events.reduce((n, e) => n + e.duration, 0);
    if (!clips.length) return false;
    const key = clips.join('\n');
    const current = findSummary(cam, date);
    if (current && current.format === FORMAT && current.clips.join('\n') === key) return false;
    if (this.failed.get(`${cam.slug}/${date}`) === key) return false;

    this.busy = { slug: cam.slug, date };
    this.opts.log.info(`${cam.slug}: building the summary for ${date} (${clips.length} clips)`);
    try {
      const meta = await this.build(cam, date, clips);
      // ffmpeg can exit cleanly with a short file when a clip vanishes mid-build (retention, a move).
      if (meta.duration < expected * 0.9 - 2) {
        for (const f of [meta.video, meta.poster]) fs.rmSync(path.join(cam.root, f), { force: true });
        throw new Error(`came out ${meta.duration}s long, but the clips add up to ${expected}s`);
      }
      fs.writeFileSync(metaFile(cam, date), JSON.stringify(meta));
      // The previous build's files, now unreferenced.
      if (current) for (const f of [current.video, current.poster]) fs.rmSync(path.join(cam.root, f), { force: true });
      this.failed.delete(`${cam.slug}/${date}`);
      this.lastError = null;
      this.opts.log.info(`${cam.slug}: summary for ${date} ready (${meta.duration}s)`);
      return true;
    } catch (err) {
      this.failed.set(`${cam.slug}/${date}`, key);
      throw err;
    }
  }

  private async build(cam: SummaryCamera, date: string, clips: string[]): Promise<SummaryMeta> {
    const dir = summaryDir(cam);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.opts.tmpDir, { recursive: true });
    const list = path.join(this.opts.tmpDir, `${cam.slug}-${date}.txt`);
    fs.writeFileSync(list, concatList(clips.map((c) => path.join(cam.root, c))));

    const name = `${cam.prefix}_${date}_${Date.now().toString(36)}`;
    const tmp = path.join(dir, `${name}.mp4.part`);
    try {
      // One pass: join (concat demuxer) and convert. The Driveway's 4K HEVC won't play in most
      // browsers, and 1080p keeps a day's summary small.
      await niced([
        'ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale=-2:'min(1080,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', tmp,
      ]);
      fs.renameSync(tmp, path.join(dir, `${name}.mp4`));
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(list, { force: true });
    }

    const video = path.join(dir, `${name}.mp4`);
    const duration = Math.round((await this.opts.probe(video)).duration);
    const at = Math.min(5, Math.max(0, duration / 2));
    await run('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(at), '-i', video,
      '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', path.join(dir, `${name}.jpg`),
    ]);
    return { format: FORMAT, clips, video: `Summary/${name}.mp4`, poster: `Summary/${name}.jpg`, duration };
  }

  /**
   * Retention: drops summaries past `summaryDays`, plus leftovers (an interrupted build's .part,
   * files no summary points at). Returns how many files it removed.
   */
  sweep(cam: SummaryCamera, summaryDays: number, now = new Date()): number {
    // Mid-build, the new video exists before the .json that points at it.
    if (this.busy?.slug === cam.slug) return 0;
    const dir = summaryDir(cam);
    const names = readdir(dir).filter((n) => n.startsWith(`${cam.prefix}_`));
    const keep = new Set<string>();
    const days = new Map<string, string>();
    for (const n of names) {
      const m = n.match(META_RE);
      if (m && m[1] === cam.prefix) days.set(m[2], n);
    }
    const old = new Set(expired([...days.keys()], Math.max(2, summaryDays), now));
    for (const [date, n] of days) {
      if (old.has(date)) continue;
      keep.add(n);
      const meta = findSummary(cam, date);
      if (meta) for (const f of [meta.video, meta.poster]) keep.add(path.basename(f));
    }
    let removed = 0;
    for (const n of names) {
      if (keep.has(n)) continue;
      fs.rmSync(path.join(dir, n), { force: true });
      removed++;
    }
    return removed;
  }
}
