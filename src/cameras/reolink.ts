import fs from 'node:fs';
import path from 'node:path';
import { DayIndex, expired, listDays } from './library';
import { DAY_RE, dayPath, isoDay } from './paths';
import { summaryDate } from './summary';

/**
 * The Reolink uploads over SFTP into the share's top-level folders, on its own schedule:
 *   YYYY/MM/DD/<Prefix>_<channel>_<YYYYMMDDHHMMSS>.mp4   event clip (4K HEVC, with pre-roll)
 *   YYYY/MM/DD/<Prefix>_<channel>_<YYYYMMDDHHMMSS>.jpg   event still, a few seconds in
 *   YYYY/MM/DD/Daily_Summary_<day>.mp4                    the DSM task's join of the day before
 * Portal reads these as they are. It never adds files to those folders, because the DSM task
 * concatenates every .mp4 it finds there; the only write is retention deleting old ones.
 */

const FILE_RE = /^(.+?)_(\d{2})_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(mp4|jpg)$/;
const SUMMARY_RE = /^Daily_Summary_.*\.mp4$/i;
/** Uploads still in progress are skipped. */
const SETTLE_MS = 2 * 60_000;

export interface ReolinkFile {
  prefix: string;
  /** the clip's own date and seconds since local midnight, from the filename */
  date: string;
  t: number;
  ext: 'mp4' | 'jpg';
}

export function parseReolink(name: string): ReolinkFile | null {
  const m = name.match(FILE_RE);
  if (!m) return null;
  const [, prefix, , y, mo, d, h, mi, s, ext] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return null;
  return { prefix, date: `${y}-${mo}-${d}`, t: +h * 3600 + +mi * 60 + +s, ext: ext as 'mp4' | 'jpg' };
}

const readdir = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** The share's own day folders (YYYY/MM/DD at the top level), newest first. */
export const shareDays = (root: string) => listDays(root, '');

/** Every filename prefix that appears in the given day folders. */
export function discoverPrefixes(root: string, days = shareDays(root)): string[] {
  const found = new Set<string>();
  for (const day of days) {
    for (const name of readdir(path.join(root, dayPath('', day)))) {
      const f = parseReolink(name);
      if (f) found.add(f.prefix);
    }
  }
  return [...found].sort();
}

/** Days that have at least one file from this camera, newest first. */
export function reolinkDays(root: string, prefix: string): string[] {
  const days = new Set<string>();
  for (const day of shareDays(root)) {
    for (const name of readdir(path.join(root, dayPath('', day)))) {
      const f = parseReolink(name);
      if (f?.prefix === prefix) days.add(f.date);
    }
  }
  return [...days].sort().reverse();
}

export type Probe = (file: string) => Promise<number>;

/**
 * One camera's clips and stills for a day. A clip that starts just before midnight can land in
 * the next day's folder, so both folders are read and files are placed by their own timestamp.
 * Clip lengths come from `probe` (ffprobe) and are cached per day under `cacheDir`.
 */
export async function reolinkDay(
  root: string,
  prefix: string,
  date: string,
  probe: Probe,
  cacheDir: string,
  now = Date.now(),
): Promise<DayIndex> {
  if (!DAY_RE.test(date)) throw new Error('date must be YYYY-MM-DD');
  const [y, m, d] = date.split('-').map(Number);
  const folders = [date, isoDay(new Date(y, m - 1, d + 1))];

  const cacheFile = path.join(cacheDir, `${prefix}-${date}.json`);
  let cache: Record<string, { size: number; duration: number }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* first look at this day */
  }
  let dirty = false;

  const index: DayIndex = { date, snapshots: [], events: [] };
  for (const folder of folders) {
    const rel = dayPath('', folder);
    for (const name of readdir(path.join(root, rel)).sort()) {
      const f = parseReolink(name);
      if (!f || f.prefix !== prefix || f.date !== date) continue;
      const full = path.join(root, rel, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < SETTLE_MS) continue;
      const file = [...rel.split(path.sep).filter(Boolean), name].join('/');
      if (f.ext === 'jpg') {
        index.snapshots.push({ t: f.t, file });
        continue;
      }
      let entry = cache[name];
      if (!entry || entry.size !== stat.size) {
        let duration = 0;
        try {
          duration = await probe(full);
        } catch {
          /* unreadable clip; shown with a nominal length */
        }
        entry = cache[name] = { size: stat.size, duration: Math.max(1, Math.round(duration)) };
        dirty = true;
      }
      index.events.push({ t: f.t, kind: 'motion', duration: entry.duration, file });
    }
  }
  index.snapshots.sort((a, b) => a.t - b.t);
  index.events.sort((a, b) => a.t - b.t);

  if (dirty) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return index;
}

/**
 * Retention for the share's top-level folders. Deletes only:
 *  - `<prefix>_NN_<timestamp>.mp4|jpg` for the given prefixes, in day folders past `clipDays`;
 *  - `Daily_Summary_*.mp4` whose footage date is past `summaryDays`.
 * Then removes day, month and year folders left empty. Anything else is left alone. Returns the
 * number of files deleted.
 */
export function sweepShare(
  root: string,
  prefixes: string[],
  keep: { clipDays: number; summaryDays: number },
  now = new Date(),
): number {
  const known = new Set(prefixes);
  const days = shareDays(root);
  const oldClips = new Set(expired(days, Math.max(2, keep.clipDays), now));
  // Same cutoff rule as expired(): keeping N days keeps today and the N-1 before it.
  const summaryBefore = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(2, keep.summaryDays) + 1));

  let removed = 0;
  for (const day of days) {
    const dir = path.join(root, dayPath('', day));
    const [y, m, d] = day.split('-').map(Number);
    const folderDay = new Date(y, m - 1, d);
    for (const name of readdir(dir)) {
      let drop = false;
      if (SUMMARY_RE.test(name)) drop = summaryDate(name, folderDay) < summaryBefore;
      else if (oldClips.has(day)) {
        const f = parseReolink(name);
        drop = Boolean(f && known.has(f.prefix));
      }
      if (!drop) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed++;
      } catch {
        /* retried next sweep */
      }
    }
    // Walk up DD → MM → YYYY, stopping at the first folder that still has something in it.
    let up = dir;
    for (let i = 0; i < 3; i++) {
      try {
        if (fs.readdirSync(up).length) break;
        fs.rmdirSync(up);
      } catch {
        break;
      }
      up = path.dirname(up);
    }
  }
  return removed;
}

export interface Usage {
  /** bytes, keyed by camera slug, then 'clips' | 'snapshots' */
  cameras: Record<string, { clips: number; snapshots: number }>;
  summaries: number;
  at: number;
}

/** Bytes in every file under `dir`, read without blocking the event loop. */
async function walk(dir: string, each: (file: string, name: string, size: number) => void): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, each);
    else if (e.isFile()) {
      try {
        each(full, e.name, (await fs.promises.stat(full)).size);
      } catch {
        /* deleted mid-walk */
      }
    }
  }
}

/** Disk used per camera and type, for the settings page. Slow on a big tree; run it in the background. */
export async function measure(
  shareRoot: string,
  footageRoot: string,
  ring: { slug: string }[],
  reolink: Record<string, { slug: string }>,
): Promise<Usage> {
  const usage: Usage = { cameras: {}, summaries: 0, at: 0 };
  const add = (slug: string, kind: 'clips' | 'snapshots', n: number) => {
    const u = (usage.cameras[slug] ??= { clips: 0, snapshots: 0 });
    u[kind] += n;
  };
  for (const cam of ring) {
    await walk(path.join(footageRoot, cam.slug), (file, _name, size) =>
      add(cam.slug, file.split(path.sep).includes('snapshots') ? 'snapshots' : 'clips', size),
    );
  }
  for (const day of shareDays(shareRoot)) {
    const dir = path.join(shareRoot, dayPath('', day));
    for (const name of readdir(dir)) {
      const isSummary = SUMMARY_RE.test(name);
      const f = isSummary ? null : parseReolink(name);
      const cam = f && reolink[f.prefix];
      if (!isSummary && !cam) continue;
      let size = 0;
      try {
        size = (await fs.promises.stat(path.join(dir, name))).size;
      } catch {
        continue;
      }
      if (isSummary) usage.summaries += size;
      else if (cam && f) add(cam.slug, f.ext === 'mp4' ? 'clips' : 'snapshots', size);
    }
  }
  usage.at = Date.now();
  return usage;
}
