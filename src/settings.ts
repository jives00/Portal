import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const LEAGUES = ['NFL', 'NBA', 'NCAAB', 'MLB'] as const;
export type League = (typeof LEAGUES)[number];

export const PhotoSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  color: z.string(),
  alt: z.string().optional(),
  credit: z.object({ name: z.string(), link: z.string().url() }),
});
export type Photo = z.infer<typeof PhotoSchema>;

const CardId = z.enum(['scores', 'stocks', 'camera']);

export const SettingsSchema = z.object({
  keywords: z.array(z.object({ name: z.string().trim().min(1).max(40), on: z.boolean() })).max(30),
  favs: z.array(PhotoSchema).max(300),
  banned: z.array(z.string()).max(2000),
  favMix: z.number().min(0).max(1),
  links: z.array(z.object({ name: z.string().trim().min(1).max(40), url: z.string().url() })).max(30),
  teams: z.array(z.object({ league: z.enum(LEAGUES), id: z.string().min(1) })).max(40),
  tickers: z.array(z.string().regex(/^[A-Z0-9.^=-]{1,12}$/)).max(25),
  showIndexes: z.boolean(),
  showLinks: z.boolean(),
  weather: z.object({
    name: z.string().max(120),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    unit: z.enum(['F', 'C']),
    hourly: z.boolean(),
  }),
  camera: z.object({ label: z.string().trim().max(40) }),
  cards: z
    .array(z.object({ id: CardId, on: z.boolean() }))
    .length(3)
    .refine((cards) => new Set(cards.map((c) => c.id)).size === 3, 'Each card must appear once'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULTS: Settings = {
  keywords: [{ name: 'spring', on: true }],
  favs: [],
  banned: [],
  favMix: 0,
  links: [
    { name: 'Pulse', url: 'http://synology:3004/pulse/' },
    { name: 'Quest', url: 'http://synology:3006' },
    { name: 'Trakt', url: 'http://synology:3001/trakt' },
    { name: 'Travel', url: 'http://synology:3003/travel' },
    { name: 'Vault', url: 'http://synology:3010/vault' },
    { name: 'DevDash', url: 'http://synology:3005' },
    { name: 'NodeCast', url: 'http://synology:3011' },
  ],
  // ESPN team ids: Cubs, White Sox, Bulls, Bears
  teams: [
    { league: 'MLB', id: '16' },
    { league: 'MLB', id: '4' },
    { league: 'NBA', id: '4' },
    { league: 'NFL', id: '3' },
  ],
  tickers: ['VBIAX', 'VOO', 'AMZN'],
  showIndexes: true,
  showLinks: true,
  weather: { name: 'Chicago, Illinois', lat: 41.88, lon: -87.63, unit: 'F', hourly: true },
  camera: { label: 'Driveway' },
  cards: [
    { id: 'scores', on: true },
    { id: 'stocks', on: true },
    { id: 'camera', on: true },
  ],
};

/** Settings live in one JSON file on the data volume, so every browser sees the same page. */
export class SettingsStore {
  private current: Settings;

  constructor(private file: string, private log: { warn: (msg: string) => void } = console) {
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  set(next: unknown): Settings {
    const parsed = SettingsSchema.parse(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
    fs.renameSync(tmp, this.file);
    this.current = parsed;
    return parsed;
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
    // Merge over defaults so settings saved by an older version pick up new fields.
    const result = SettingsSchema.safeParse({ ...structuredClone(DEFAULTS), ...(raw as object) });
    if (result.success) return result.data;
    this.log.warn(`${this.file} failed validation, using defaults: ${result.error.message}`);
    return structuredClone(DEFAULTS);
  }
}
