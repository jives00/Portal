import fs from 'node:fs';
import path from 'node:path';
import { DayIndex, expired, listDays } from './library';
import { DAY_RE, FOLDER_RE, dayPath, isoDay } from './paths';

/**
 * The Reolinks upload over FTP, each into its own folder of the share, on their own schedule:
 *   <folder>/YYYY/MM/DD/<Prefix>_<channel>_<YYYYMMDDHHMMSS>.mp4   event clip (with pre-roll)
 *   <folder>/YYYY/MM/DD/<Prefix>_<channel>_<YYYYMMDDHHMMSS>.jpg   event still, a few seconds in
 * Portal reads these as they are. Its only writes there are retention deleting old ones; the
 * daily summaries it builds go in `<folder>/Summary/` (see summaries.ts).
 *
 * Functions here take a camera's folder (`<share>/<folder>`) as their root. '' (the share's top
 * level) is the old layout, from before 2026-11-18; it still works.
 */

const FILE_RE = /^(.+?)_(\d{2})_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(mp4|jpg)$/;
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

export const readdir = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** A folder's own day folders (YYYY/MM/DD directly under it), newest first. */
export const shareDays = (root: string) => listDays(root, '');

/** Share folders holding a YYYY/MM/DD tree, i.e. a camera's upload folder. */
export function uploadFolders(root: string, skip: string[] = []): string[] {
  return readdir(root)
    .filter((n) => FOLDER_RE.test(n) && !/^\d{4}$/.test(n) && !skip.includes(n) && listDays(root, n).length > 0)
    .sort();
}

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

export type Probe = (file: string) => Promise<{ duration: number; codec: string }>;

/**
 * One camera's clips and stills for a day. A clip that starts just before midnight can land in
 * the next day's folder, so both folders are read and files are placed by their own timestamp.
 * Clip lengths and codecs come from `probe` (ffprobe) and are cached per day under `cacheDir`.
 * File paths are relative to `root`.
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
  let cache: Record<string, { size: number; duration: number; codec?: string }> = {};
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
      // Entries from before codecs were recorded are probed again.
      if (!entry || entry.size !== stat.size || entry.codec === undefined) {
        let duration = 0;
        let codec = '';
        try {
          ({ duration, codec } = await probe(full));
        } catch {
          /* unreadable clip; shown with a nominal length */
        }
        entry = cache[name] = { size: stat.size, duration: Math.max(1, Math.round(duration)), codec };
        dirty = true;
      }
      index.events.push({ t: f.t, kind: 'motion', duration: entry.duration, file, hevc: entry.codec === 'hevc' });
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
 * Retention for one camera folder. Deletes only `<prefix>_NN_<timestamp>.mp4|jpg` for the given
 * prefixes, in day folders past `clipDays`, then day, month and year folders left empty. Anything
 * else is left alone. Returns the number of files deleted.
 */
export function sweepShare(root: string, prefixes: string[], clipDays: number, now = new Date()): number {
  const known = new Set(prefixes);
  const days = shareDays(root);
  const old = new Set(expired(days, Math.max(2, clipDays), now));

  let removed = 0;
  for (const day of days) {
    const dir = path.join(root, dayPath('', day));
    if (old.has(day)) {
      for (const name of readdir(dir)) {
        const f = parseReolink(name);
        if (!f || !known.has(f.prefix)) continue;
        try {
          fs.rmSync(path.join(dir, name), { force: true });
          removed++;
        } catch {
          /* retried next sweep */
        }
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
  /** bytes, keyed by camera slug */
  cameras: Record<string, { clips: number; snapshots: number; summaries: number }>;
  at: number;
}

/** Disk used per camera and type, for the settings page. Slow on a big tree; run it in the background. */
export async function measure(shareRoot: string, cameras: Record<string, { slug: string; folder: string }>): Promise<Usage> {
  const usage: Usage = { cameras: {}, at: 0 };
  const size = async (file: string) => {
    try {
      return (await fs.promises.stat(file)).size;
    } catch {
      return 0;
    }
  };
  for (const [prefix, cam] of Object.entries(cameras)) {
    const u = (usage.cameras[cam.slug] = { clips: 0, snapshots: 0, summaries: 0 });
    const root = path.join(shareRoot, cam.folder);
    for (const day of shareDays(root)) {
      const dir = path.join(root, dayPath('', day));
      for (const name of readdir(dir)) {
        const f = parseReolink(name);
        if (f?.prefix === prefix) u[f.ext === 'mp4' ? 'clips' : 'snapshots'] += await size(path.join(dir, name));
      }
    }
    const sums = path.join(root, 'Summary');
    for (const name of readdir(sums)) if (name.startsWith(`${prefix}_`)) u.summaries += await size(path.join(sums, name));
  }
  usage.at = Date.now();
  return usage;
}
