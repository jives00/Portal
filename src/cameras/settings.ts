import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FOLDER_RE, SLUG_RE } from './paths';

/** A Reolink camera, keyed by the filename prefix it uploads under (`Driveway_00_…`). */
export const CameraSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** id in the viewer and its URLs; fixed once the prefix is first seen */
  slug: z.string().regex(SLUG_RE),
  /**
   * Share folder it uploads into ('' = the share's top level, the old layout). Set by discovery,
   * never from outside: it follows the files if they move.
   */
  folder: z.union([z.literal(''), z.string().regex(FOLDER_RE)]).default(''),
  /** RTSP URL for live view, credentials included; '' = no live view */
  rtsp: z.union([z.literal(''), z.string().trim().regex(/^rtsps?:\/\/\S+$/, 'must start with rtsp://')]).default(''),
});

export const SettingsSchema = z.object({
  /** Days of clips and stills to keep on the NAS. Never under 2, so yesterday's summary can be built. */
  clipDays: z.number().int().min(2).max(730),
  /** Days of daily summaries to keep. */
  summaryDays: z.number().int().min(2).max(730),
  cameras: z.record(CameraSchema),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Camera = z.infer<typeof CameraSchema>;

export const DEFAULTS: Settings = { clipDays: 90, summaryDays: 14, cameras: {} };

/** What the API shows for a password: the settings page round-trips it untouched. */
const MASK = '••••';
/** user, password (may itself hold @ or :), then @host[:port] and the path */
const PASSWORD_RE = /^(rtsps?:\/\/[^:/@\s]*:)(.*)(@[^@/\s]+(?:\/.*)?)$/;

/** The RTSP URL with its password hidden, for the API. */
export const maskRtsp = (url: string) => url.replace(PASSWORD_RE, (_, a, pw, b) => `${a}${pw ? MASK : ''}${b}`);

/** Settings as the API returns them: passwords masked. */
export function publicSettings(s: Settings): Settings {
  return { ...s, cameras: Object.fromEntries(Object.entries(s.cameras).map(([k, c]) => [k, { ...c, rtsp: maskRtsp(c.rtsp) }])) };
}

/** Portal ≤ Nov 2026 kept Ring settings at the top level and the Reolinks under `reolink`. */
function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  const old = r.reolink as Partial<Settings> | undefined;
  if (!old || typeof old !== 'object') return raw;
  const out: Record<string, unknown> = { cameras: old.cameras ?? {} };
  if (old.clipDays !== undefined) out.clipDays = old.clipDays;
  if (old.summaryDays !== undefined) out.summaryDays = old.summaryDays;
  return out;
}

export class SettingsStore {
  private current: Settings;

  constructor(private file: string, private log: { warn: (msg: string) => void } = console) {
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  /**
   * Replaces the settings. Slugs and folders can't be changed from outside, cameras can't be
   * added that way, and a masked RTSP password (as the API showed it) keeps the stored one.
   */
  set(next: unknown): Settings {
    const parsed = SettingsSchema.parse(next);
    for (const [prefix, cam] of Object.entries(parsed.cameras)) {
      const known = this.current.cameras[prefix];
      if (!known) {
        delete parsed.cameras[prefix];
        continue;
      }
      const rtsp = cam.rtsp && cam.rtsp === maskRtsp(known.rtsp) ? known.rtsp : cam.rtsp;
      parsed.cameras[prefix] = { ...cam, slug: known.slug, folder: known.folder, rtsp };
    }
    return this.write(parsed);
  }

  /** Records a newly seen filename prefix, and the share folder it was found in. */
  addCamera(prefix: string, slug: string, folder = ''): Camera {
    const added: Camera = { name: prefix, slug: this.freeSlug(slug), folder, rtsp: '' };
    this.write({ ...this.current, cameras: { ...this.current.cameras, [prefix]: added } });
    return added;
  }

  /** A camera's uploads now live in another folder (the move into per-camera folders). */
  moveCamera(prefix: string, folder: string): Camera | null {
    const cam = this.current.cameras[prefix];
    if (!cam) return null;
    const next = { ...cam, folder };
    this.write({ ...this.current, cameras: { ...this.current.cameras, [prefix]: next } });
    return next;
  }

  private freeSlug(base: string): string {
    const taken = new Set(Object.values(this.current.cameras).map((c) => c.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 36)}-${n}`;
    return slug;
  }

  private write(settings: Settings): Settings {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, this.file);
    this.current = settings;
    return settings;
  }

  private load(): Settings {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Could not read ${this.file}, using defaults: ${(err as Error).message}`);
      }
      return structuredClone(DEFAULTS);
    }
    // Merge over defaults so a file saved by an older version picks up new fields.
    const result = SettingsSchema.safeParse({ ...structuredClone(DEFAULTS), ...(migrate(raw) as object) });
    if (result.success) return result.data;
    this.log.warn(`${this.file} failed validation, using defaults: ${result.error.message}`);
    return structuredClone(DEFAULTS);
  }
}
