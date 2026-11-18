import path from 'node:path';

/**
 * Footage layout on the SecurityCameras share: each Reolink uploads into a folder of its own,
 *   <folder>/YYYY/MM/DD/<Prefix>_<channel>_<YYYYMMDDHHMMSS>.{mp4,jpg}
 * and Portal writes that camera's daily summaries next to it, in <folder>/Summary/.
 * All times are local (the container runs with TZ=America/Chicago).
 */

const pad = (n: number) => String(n).padStart(2, '0');

export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A share folder a Reolink uploads into (`<share>/<folder>/YYYY/MM/DD/`). */
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** `<camera>/YYYY/MM/DD` for a Date or a YYYY-MM-DD string. */
export function dayPath(camera: string, day: Date | string): string {
  const iso = typeof day === 'string' ? day : isoDay(day);
  const [y, m, d] = iso.split('-');
  return path.join(camera, y, m, d);
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
