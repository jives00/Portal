import fs from 'node:fs';
import path from 'node:path';
import { isoDay } from './paths';

/** Day-folder helpers shared by the share reader, retention and the thumbnail cache. */

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

/** Every YYYY-MM-DD that has a folder under `<root>/<sub>/YYYY/MM/DD`, newest first. */
export function listDays(root: string, sub: string): string[] {
  const days: string[] = [];
  const base = path.join(root, sub);
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
  /** seconds since local midnight, and the path under /share/ */
  snapshots: { t: number; file: string }[];
  /** `hevc`: the browser may not be able to play it (the Driveway's 4K clips) */
  events: { t: number; kind: 'motion'; duration: number; file: string; hevc: boolean }[];
}

/** Days past retention, as of `now`. Keeping N days keeps today and the N-1 before it. */
export function expired(days: string[], keepDays: number, now = new Date()): string[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays + 1);
  const cut = isoDay(cutoff);
  return days.filter((d) => d < cut);
}
