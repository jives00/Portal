import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SLUG_RE } from './paths';

export const CameraSchema = z.object({
  /** display name; editable */
  name: z.string().trim().min(1).max(60),
  /** folder name under the storage root; fixed once the camera is first seen */
  slug: z.string().regex(SLUG_RE),
  /** Ring location id, needed to address its MQTT command topics */
  location: z.string(),
  enabled: z.boolean().default(true),
});

/** A Reolink camera, keyed by the filename prefix it uploads under (`Driveway_00_…`). */
export const ReolinkCameraSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** id in the viewer and its URLs; fixed once the prefix is first seen */
  slug: z.string().regex(SLUG_RE),
});

export const ReolinkSchema = z.object({
  /**
   * Days of Reolink clips and stills to keep on the NAS. Never under 2: the DSM task joins
   * yesterday's clips into the daily summary the next morning.
   */
  clipDays: z.number().int().min(2).max(730),
  summaryDays: z.number().int().min(2).max(730),
  cameras: z.record(ReolinkCameraSchema),
});

export const SettingsSchema = z.object({
  snapshotDays: z.number().int().min(1).max(365),
  eventDays: z.number().int().min(1).max(730),
  /** seconds between Ring interval snapshots; Ring may not honor very short values */
  snapshotInterval: z.number().int().min(10).max(600),
  /** seconds each clip runs after its latest motion event or ding */
  clipLength: z.number().int().min(15).max(300),
  /** keyed by Ring device id */
  cameras: z.record(CameraSchema),
  /** cameras that upload into the share's top-level YYYY/MM/DD folders */
  reolink: ReolinkSchema,
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type ReolinkCamera = z.infer<typeof ReolinkCameraSchema>;

export const DEFAULTS: Settings = {
  snapshotDays: 30,
  eventDays: 90,
  snapshotInterval: 30,
  clipLength: 60,
  cameras: {},
  reolink: { clipDays: 90, summaryDays: 14, cameras: {} },
};

export class SettingsStore {
  private current: Settings;

  constructor(private file: string, private log: { warn: (msg: string) => void } = console) {
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  /** Replaces the settings. Camera slugs and locations can't be changed from outside. */
  set(next: unknown): Settings {
    const parsed = SettingsSchema.parse(next);
    for (const [id, cam] of Object.entries(parsed.cameras)) {
      const known = this.current.cameras[id];
      if (!known) delete parsed.cameras[id];
      else parsed.cameras[id] = { ...cam, slug: known.slug, location: known.location };
    }
    for (const [prefix, cam] of Object.entries(parsed.reolink.cameras)) {
      const known = this.current.reolink.cameras[prefix];
      if (!known) delete parsed.reolink.cameras[prefix];
      else parsed.reolink.cameras[prefix] = { ...cam, slug: known.slug };
    }
    return this.write(parsed);
  }

  /** Records a newly seen Ring camera, picking a slug no other camera uses. */
  addCamera(id: string, cam: Omit<Camera, 'enabled'>): Camera {
    const added: Camera = { ...cam, slug: this.freeSlug(cam.slug), enabled: true };
    this.write({ ...this.current, cameras: { ...this.current.cameras, [id]: added } });
    return added;
  }

  /** Records a newly seen Reolink filename prefix. */
  addReolink(prefix: string, slug: string): ReolinkCamera {
    const added: ReolinkCamera = { name: prefix, slug: this.freeSlug(slug) };
    const reolink = { ...this.current.reolink, cameras: { ...this.current.reolink.cameras, [prefix]: added } };
    this.write({ ...this.current, reolink });
    return added;
  }

  /** Internal updates (a discovered name, say); unlike set(), this may change the slug. */
  updateCamera(id: string, patch: Partial<Camera>): Camera | null {
    const cam = this.current.cameras[id];
    if (!cam) return null;
    const next = { ...cam, ...patch };
    this.write({ ...this.current, cameras: { ...this.current.cameras, [id]: next } });
    return next;
  }

  /** Ring and Reolink slugs share one namespace, since both appear in the same viewer. */
  private freeSlug(base: string): string {
    const s = this.current;
    const taken = new Set([...Object.values(s.cameras), ...Object.values(s.reolink.cameras)].map((c) => c.slug));
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
    // Merge over defaults so a file saved by an older version (Sentry's, say) picks up new fields.
    const result = SettingsSchema.safeParse({ ...structuredClone(DEFAULTS), ...(raw as object) });
    if (result.success) return result.data;
    this.log.warn(`${this.file} failed validation, using defaults: ${result.error.message}`);
    return structuredClone(DEFAULTS);
  }
}
