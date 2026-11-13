import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * What the DevDash tab tracks, edited from the tab (or `PUT/DELETE /api/devdash/services/:name`,
 * which `/register-project` uses). Stored at `$DATA_DIR/devdash.json`; seeded from DEFAULTS, the
 * list the standalone DevDash app had in `devdash/lib/projects.ts` when Portal took it over.
 */

export const KINDS = ['app', 'bot', 'infra'] as const;
export type Kind = (typeof KINDS)[number];

const containerName = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'container names are letters, digits, _ . -');

const url = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'must start with http:// or https://');

export const ServiceSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(40),
  kind: z.enum(KINDS),
  containers: z.array(containerName).min(1, 'at least one container'),
  /** Fetched from inside Portal's container, so names on the shared-db network resolve. */
  healthUrl: url.nullable().default(null),
  webUrl: url.nullable().default(null),
  /** Scheduled containers that run and exit (shown as "last run"), attached to this service. */
  oneShot: z.array(z.object({ name: z.string().trim().min(1), container: containerName })).default([]),
});
export type Service = z.infer<typeof ServiceSchema>;

export const RegistrySchema = z
  .object({ services: z.array(ServiceSchema) })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.services.forEach((s, i) => {
      const key = s.name.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['services', i, 'name'], message: `"${s.name}" is listed twice` });
      seen.add(key);
    });
  });
export type Registry = z.infer<typeof RegistrySchema>;

const svc = (s: Partial<Service> & Pick<Service, 'name' | 'kind' | 'containers'>): Service => ({
  healthUrl: null,
  webUrl: null,
  oneShot: [],
  ...s,
});

export const DEFAULTS: Registry = {
  services: [
    svc({ name: 'Quest', kind: 'app', containers: ['quest-web', 'quest-api'], healthUrl: 'http://quest-api:3007/health', webUrl: 'http://synology:3006' }),
    svc({ name: 'Trakt', kind: 'app', containers: ['trakt-web', 'trakt-api'], healthUrl: 'http://trakt-api:3002/health', webUrl: 'http://synology:3001/trakt' }),
    svc({
      name: 'Pulse',
      kind: 'app',
      containers: ['pulse-server', 'pulse-web'],
      healthUrl: 'http://pulse-server:3000/api/health',
      webUrl: 'http://synology:3004/pulse/',
      oneShot: [{ name: 'Weight Sync', container: 'pulse-scripts' }],
    }),
    svc({ name: 'Travel', kind: 'app', containers: ['travel-web', 'travel-api'], healthUrl: 'http://travel-api:3008/health', webUrl: 'http://synology:3003/travel' }),
    svc({ name: 'Vault', kind: 'app', containers: ['vault-web', 'vault-api'], healthUrl: 'http://vault-api:3009/health', webUrl: 'http://synology:3010/vault' }),
    svc({ name: 'Scout', kind: 'app', containers: ['scout-web', 'scout-api'], healthUrl: 'http://scout-api:3016/health', webUrl: 'http://synology:3015' }),
    // Portal checks itself over loopback.
    svc({ name: 'Portal', kind: 'app', containers: ['portal', 'portal-ring', 'portal-mqtt'], healthUrl: 'http://127.0.0.1:3012/health', webUrl: 'http://synology:3012' }),
    svc({ name: 'Signal', kind: 'app', containers: ['signal'], healthUrl: 'http://signal:3013/health', webUrl: 'http://synology:3013' }),
    svc({ name: 'NodeCast TV', kind: 'app', containers: ['nodecast-tv'], webUrl: 'http://synology:3011' }),
    svc({ name: 'AlpacaBot', kind: 'bot', containers: ['alpacabot'] }),
    svc({ name: 'BSNSFWBot', kind: 'bot', containers: ['bsnsfwbot'] }),
    svc({ name: 'MySQL', kind: 'infra', containers: ['shared-mysql-1'] }),
    svc({ name: 'Watchtower', kind: 'infra', containers: ['shared-watchtower-1'] }),
    svc({ name: 'Adminer', kind: 'infra', containers: ['shared-adminer-1'] }),
  ],
};

export class RegistryStore {
  private current: Registry;

  constructor(private file: string, private log: { warn: (msg: string) => void } = console) {
    this.current = this.load();
  }

  get(): Registry {
    return this.current;
  }

  /** Adds a new service; throws when the name is taken. */
  add(body: unknown): Service {
    const next = ServiceSchema.parse(body);
    if (this.current.services.some((s) => s.name.toLowerCase() === next.name.toLowerCase())) {
      throw Object.assign(new Error(`"${next.name}" is already tracked`), { statusCode: 409 });
    }
    this.save({ services: [...this.current.services, next] });
    return next;
  }

  /** Adds a service, or replaces the one named `name` (which may rename it). */
  put(name: string, body: unknown): Service {
    const next = ServiceSchema.parse(body);
    const services = [...this.current.services];
    const i = services.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) services[i] = next;
    else services.push(next);
    this.save({ services });
    return next;
  }

  /** False when nothing had that name. */
  remove(name: string): boolean {
    const services = this.current.services.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
    if (services.length === this.current.services.length) return false;
    this.save({ services });
    return true;
  }

  /** Every container the tab may show logs for. */
  containers(): Set<string> {
    return new Set(this.current.services.flatMap((s) => [...s.containers, ...s.oneShot.map((o) => o.container)]));
  }

  private save(next: unknown) {
    const parsed = RegistrySchema.parse(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
    fs.renameSync(tmp, this.file);
    this.current = parsed;
  }

  private load(): Registry {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Could not read ${this.file}, using the default service list: ${(err as Error).message}`);
      }
      return structuredClone(DEFAULTS);
    }
    const result = RegistrySchema.safeParse(raw);
    if (result.success) return result.data;
    this.log.warn(`${this.file} failed validation, using the default service list: ${result.error.message}`);
    return structuredClone(DEFAULTS);
  }
}
