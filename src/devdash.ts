import { TtlCache } from './cache';
import { getJson } from './http';

/**
 * The DevDash tab. DevDash (separate app, port 3005) owns the Docker socket and the project list;
 * Portal only reads its API and reshapes it into one payload: containers, per-project health, and
 * the MySQL backup status. Nothing is configured here, so a project registered in DevDash shows
 * up in both places.
 */

interface DevdashProject {
  name: string;
  healthUrl: string | null;
  [k: string]: unknown;
}
interface DevdashContainers {
  projects: DevdashProject[];
  infrastructure: unknown[];
}
export interface Health {
  ok: boolean;
  latencyMs: number;
  db?: string;
  error?: string;
}

const cache = new TtlCache<unknown>(8_000);

export function devdash(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '');

  async function health(name: string): Promise<Health> {
    try {
      const h = await getJson<Health>(`${base}/api/health/${encodeURIComponent(name)}`, {}, 7000);
      return { ok: !!h.ok, latencyMs: h.latencyMs ?? 0, db: h.db, error: h.error };
    } catch (err) {
      return { ok: false, latencyMs: 0, error: (err as Error).message };
    }
  }

  async function load() {
    const [containers, backup] = await Promise.all([
      getJson<DevdashContainers>(`${base}/api/containers`, {}, 15000),
      getJson<unknown>(`${base}/api/backup-status`).catch(() => null),
    ]);
    const projects = await Promise.all(
      containers.projects.map(async (p) => ({ ...p, health: p.healthUrl ? await health(p.name) : null })),
    );
    return { projects, infrastructure: containers.infrastructure, backup, at: new Date().toISOString() };
  }

  return { get: () => cache.get('all', load) };
}
