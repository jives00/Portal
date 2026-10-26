import path from 'node:path';

/**
 * Footage layout, relative to the storage root:
 *   <camera>/YYYY/MM/DD/events/HH-MM-SS_<kind>_<seconds>s.mp4
 *   <camera>/YYYY/MM/DD/snapshots/HH-MM-SS.jpg
 * All times are local (the container runs with TZ=America/Chicago).
 */

export type EventKind = 'motion' | 'ding';

const pad = (n: number) => String(n).padStart(2, '0');

export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const clock = (d: Date) => `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `<camera>/YYYY/MM/DD` for a Date or a YYYY-MM-DD string. */
export function dayPath(camera: string, day: Date | string): string {
  const iso = typeof day === 'string' ? day : isoDay(day);
  const [y, m, d] = iso.split('-');
  return path.join(camera, y, m, d);
}

export const eventName = (start: Date, kind: EventKind, seconds: number) =>
  `${clock(start)}_${kind}_${Math.max(1, Math.round(seconds))}s.mp4`;

const EVENT_RE = /^(\d{2})-(\d{2})-(\d{2})_(motion|ding)_(\d+)s\.mp4$/;
const SNAPSHOT_RE = /^(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.jpg$/;

/** Seconds since local midnight, kind and length, from an event clip's filename. */
export function parseEvent(name: string): { t: number; kind: EventKind; duration: number } | null {
  const m = name.match(EVENT_RE);
  if (!m) return null;
  return { t: +m[1] * 3600 + +m[2] * 60 + +m[3], kind: m[4] as EventKind, duration: +m[5] };
}

/** Seconds since local midnight, from a snapshot's filename. */
export function parseSnapshot(name: string): number | null {
  const m = name.match(SNAPSHOT_RE);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'camera';
}
