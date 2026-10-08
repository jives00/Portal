import { getJson } from './http';
import type { Photo, Settings } from './settings';

export type ServedPhoto = Photo & { kw: string };

const UTM = 'utm_source=portal&utm_medium=referral';
const UNSPLASH_HOME = `https://unsplash.com/?${UTM}`;

/** Used when there's no Unsplash key or Unsplash is down, so the page is never blank. */
const FALLBACK_IDS: [string, string][] = [
  ['1462275646964-a0e3386b89fa', '#c3adbb'],
  ['1468327768560-75b778cbb551', '#a2999c'],
  ['1490750967868-88aa4486c946', '#75906f'],
  ['1522383225653-ed111181a951', '#d9b2bc'],
  ['1441974231531-c6227db76b6e', '#545038'],
  ['1470252649378-9c29740c9fa8', '#805935'],
  ['1491147334573-44cbb4602074', '#3f604e'],
  ['1464822759023-fed622ff2c3b', '#6d7f8c'],
  ['1506744038136-46273834b3fb', '#8a97a1'],
  ['1500530855697-b586d89ba3ee', '#8a5a48'],
];
export const FALLBACK: Photo[] = FALLBACK_IDS.map(([id, color]) => ({
  id,
  url: `https://images.unsplash.com/photo-${id}`,
  color,
  credit: { name: 'Unsplash', link: UNSPLASH_HOME },
}));

interface UnsplashPhoto {
  id: string;
  color: string | null;
  alt_description: string | null;
  urls: { raw: string };
  user: { name: string; links: { html: string } };
  links: { download_location: string };
}

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

/**
 * Hands out one Unsplash photo per page load. Each keyword keeps a pool of ~30 photos from one
 * `/photos/random` call, so a page load almost never waits on Unsplash and the 50 req/hr demo
 * limit is far away.
 */
export class PhotoService {
  private pools = new Map<string, (ServedPhoto & { download: string })[]>();
  private refilling = new Map<string, Promise<void>>();

  constructor(
    private accessKey: string | undefined,
    private log: { warn: (msg: string) => void },
  ) {}

  get configured(): boolean {
    return Boolean(this.accessKey);
  }

  async next(settings: Settings, lastId?: string): Promise<ServedPhoto> {
    const banned = new Set(settings.banned);

    if (settings.favs.length && Math.random() < settings.favMix) {
      const favs = settings.favs.filter((p) => p.id !== lastId && !banned.has(p.id));
      if (favs.length) return { ...pick(favs), kw: 'favorite' };
    }

    const active = settings.keywords.filter((k) => k.on).map((k) => k.name.toLowerCase());
    const kw = active.length ? pick(active) : 'spring';

    if (this.accessKey) {
      try {
        const photo = await this.take(kw, banned);
        if (photo) {
          this.trackDownload(photo.download);
          const { download: _download, ...rest } = photo;
          return rest;
        }
      } catch (err) {
        this.log.warn(`Unsplash failed for "${kw}": ${(err as Error).message}`);
      }
    }

    const choices = FALLBACK.filter((p) => !banned.has(p.id) && p.id !== lastId);
    return { ...pick(choices.length ? choices : FALLBACK), kw: this.accessKey ? kw : 'built-in' };
  }

  private async take(kw: string, banned: Set<string>) {
    let pool = (this.pools.get(kw) ?? []).filter((p) => !banned.has(p.id));
    this.pools.set(kw, pool);
    if (!pool.length) {
      await this.refill(kw);
      pool = (this.pools.get(kw) ?? []).filter((p) => !banned.has(p.id));
      this.pools.set(kw, pool);
    }
    const photo = pool.shift();
    if (pool.length < 5) {
      this.refill(kw).catch((err) => this.log.warn(`Unsplash refill for "${kw}" failed: ${err.message}`));
    }
    return photo;
  }

  private refill(kw: string): Promise<void> {
    const existing = this.refilling.get(kw);
    if (existing) return existing;
    const job = (async () => {
      const url =
        'https://api.unsplash.com/photos/random' +
        `?query=${encodeURIComponent(kw)}&orientation=landscape&count=30&content_filter=high`;
      const batch = await getJson<UnsplashPhoto[]>(url, this.headers());
      const pool = this.pools.get(kw) ?? [];
      const seen = new Set(pool.map((p) => p.id));
      for (const u of batch) {
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        pool.push({
          id: u.id,
          url: u.urls.raw,
          color: u.color ?? '#556070',
          alt: u.alt_description ?? undefined,
          credit: { name: u.user.name, link: `${u.user.links.html}?${UTM}` },
          kw,
          download: u.links.download_location,
        });
      }
      this.pools.set(kw, pool);
    })().finally(() => this.refilling.delete(kw));
    this.refilling.set(kw, job);
    return job;
  }

  /** Unsplash's API terms require hitting download_location whenever a photo is shown. */
  private trackDownload(url: string) {
    fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
  }

  private headers() {
    return { Authorization: `Client-ID ${this.accessKey}`, 'Accept-Version': 'v1' };
  }
}
