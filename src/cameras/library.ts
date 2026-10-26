import fs from 'node:fs';
import path from 'node:path';
import { DAY_RE, EventKind, dayPath, isoDay, parseEvent, parseSnapshot } from './paths';

/** Reads the footage tree back for the viewer and for retention. */

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const list = (dir: string, re: RegExp) => {
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).sort();
  } catch {
    return [];
  }
};

/** Every YYYY-MM-DD that has a folder for this camera, newest first. */
export function listDays(root: string, slug: string): string[] {
  const days: string[] = [];
  const base = path.join(root, slug);
  for (const y of list(base, /^\d{4}$/)) {
    for (const m of list(path.join(base, y), /^\d{2}$/)) {
      for (const d of list(path.join(base, y, m), /^\d{2}$/)) {
        if (isDir(path.join(base, y, m, d))) days.push(`${y}-${m}-${d}`);
      }
    }
  }
  return days.sort().reverse();
}

export interface DayIndex {
  date: string;
  /** seconds since local midnight, and the path under /footage/ */
  snapshots: { t: number; file: string }[];
  events: { t: number; kind: EventKind; duration: number; file: string }[];
}

export function dayIndex(root: string, slug: string, date: string): DayIndex {
  if (!DAY_RE.test(date)) throw new Error('date must be YYYY-MM-DD');
  const rel = dayPath(slug, date);
  const url = (sub: string, name: string) => [...rel.split(path.sep), sub, name].join('/');

  const snapshots = list(path.join(root, rel, 'snapshots'), /\.jpg$/)
    .map((name) => ({ t: parseSnapshot(name), file: url('snapshots', name) }))
    .filter((s): s is { t: number; file: string } => s.t !== null);
  const events = list(path.join(root, rel, 'events'), /\.mp4$/)
    .map((name) => {
      const parsed = parseEvent(name);
      return parsed && { ...parsed, file: url('events', name) };
    })
    .filter((e) => e !== null);

  return { date, snapshots, events };
}

/** Days whose snapshots or events are past retention, as of `now`. */
export function expired(days: string[], keepDays: number, now = new Date()): string[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays + 1);
  const cut = isoDay(cutoff);
  return days.filter((d) => d < cut);
}

/**
 * Deletes snapshots older than `snapshotDays` and events older than `eventDays`, then any day,
 * month and year folders left empty. Returns how many folders it removed.
 */
export function sweep(root: string, slug: string, keep: { snapshotDays: number; eventDays: number }, now = new Date()): number {
  const days = listDays(root, slug);
  let removed = 0;
  for (const [sub, n] of [['snapshots', keep.snapshotDays], ['events', keep.eventDays]] as const) {
    for (const day of expired(days, n, now)) {
      const dir = path.join(root, dayPath(slug, day), sub);
      if (isDir(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
  }
  for (const day of days) {
    let dir = path.join(root, dayPath(slug, day));
    // Walk up DD → MM → YYYY, stopping at the first folder that still has something in it.
    for (let i = 0; i < 3; i++) {
      try {
        if (fs.readdirSync(dir).length) break;
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
  return removed;
}
