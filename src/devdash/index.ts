import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TtlCache } from '../cache';
import { ContainerInspect, ContainerSummary, Docker, LogLine } from './docker';
import { RegistryStore, Service } from './registry';

/**
 * The DevDash tab (formerly the standalone DevDash app, port 3005). Portal reads Docker through
 * the mounted socket, checks each service's health URL, reads the nightly MySQL backup's status
 * file, and streams container logs. What's tracked lives in RegistryStore.
 */

export interface DevdashOptions {
  dataDir: string;
  socketPath: string;
  /** backup.sh writes {timestamp, success, sizeMb, error} here after each run. */
  backupStatusFile: string;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

/** The same test the old DevDash used, so its error badges mean the same thing. */
export const ERROR_RE = /error|exception|traceback|critical/i;
/** Errors older than this, or from before the container last started, aren't actionable. */
const ERROR_WINDOW_S = 6 * 3600;
const SINCE: Record<string, number> = { '2h': 7200, '6h': 21600, '24h': 86400 };

export function countErrors(lines: LogLine[]) {
  const errs = lines.filter((l) => ERROR_RE.test(l.text));
  return { count: errs.length, last: errs.length ? errs[errs.length - 1].text.slice(0, 200) : null };
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

type Status = 'running' | 'stopped' | 'restarting' | 'unknown';
const statusOf = (i: ContainerInspect): Status => (i.State.Running ? 'running' : i.State.Restarting ? 'restarting' : 'stopped');
const hasRun = (t?: string) => !!t && !t.startsWith('0001-');

export function devdash(app: FastifyInstance, opts: DevdashOptions) {
  const docker = new Docker(opts.socketPath);
  const registry = new RegistryStore(path.join(opts.dataDir, 'devdash.json'), opts.log);
  const cache = new TtlCache<unknown>(8_000);

  async function health(url: string) {
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => ({}))) as { db?: unknown; error?: unknown };
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
        db: typeof body.db === 'string' ? body.db : undefined,
        error: res.ok ? undefined : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, latencyMs: 0, error: (err as Error).message };
    }
  }

  async function backup() {
    try {
      return { backup: JSON.parse(await fs.readFile(opts.backupStatusFile, 'utf8')), backupError: null };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { backup: null, backupError: e.code === 'ENOENT' ? `${opts.backupStatusFile} not found` : e.message };
    }
  }

  async function load() {
    const services = registry.get().services;
    let byName = new Map<string, ContainerSummary>();
    let dockerError: string | null = null;
    try {
      for (const c of await docker.list()) for (const n of c.Names) byName.set(n.replace(/^\//, ''), c);
    } catch (err) {
      dockerError = (err as Error).message;
      byName = new Map();
    }
    const inspect = async (name: string) => {
      const c = byName.get(name);
      return c ? docker.inspect(c.Id).catch(() => null) : null;
    };

    async function container(name: string, withLogs: boolean) {
      const i = await inspect(name);
      if (!i) return { name, info: null, errorCount: 0, lastError: null, logPreview: [], lastMessage: null };
      const started = hasRun(i.State.StartedAt) ? new Date(i.State.StartedAt).getTime() : 0;
      const info = {
        status: statusOf(i),
        uptime: i.State.Running && started ? formatUptime(Date.now() - started) : '',
        restartCount: i.RestartCount ?? 0,
      };
      if (!withLogs) return { name, info, errorCount: 0, lastError: null, logPreview: [], lastMessage: null };
      const since = Math.max(Math.floor(started / 1000), Math.floor(Date.now() / 1000) - ERROR_WINDOW_S);
      const tty = i.Config?.Tty ?? false;
      const [recent, tail] = await Promise.all([
        docker.logs(i.Id, tty, { tail: 200, since }).catch(() => []),
        docker.logs(i.Id, tty, { tail: 10 }).catch(() => []),
      ]);
      const errs = countErrors(recent);
      return {
        name,
        info,
        errorCount: errs.count,
        lastError: errs.last,
        logPreview: tail.slice(-5).map((l) => l.text),
        lastMessage: tail.length ? tail[tail.length - 1].text : null,
      };
    }

    const out = await Promise.all(
      services.map(async (s: Service) => {
        const [containers, oneShot, h] = await Promise.all([
          Promise.all(s.containers.map((c) => container(c, s.kind !== 'infra'))),
          Promise.all(
            s.oneShot.map(async (o) => {
              const i = await inspect(o.container);
              return { ...o, exitCode: i?.State.ExitCode ?? null, finishedAt: i && hasRun(i.State.FinishedAt) ? i.State.FinishedAt : null };
            }),
          ),
          s.healthUrl ? health(s.healthUrl) : Promise.resolve(null),
        ]);
        return { name: s.name, kind: s.kind, webUrl: s.webUrl, healthUrl: s.healthUrl, containers, oneShot, health: h };
      }),
    );
    return { services: out, ...(await backup()), docker: dockerError, at: new Date().toISOString() };
  }

  app.get('/api/devdash', async () => cache.get('all', load));

  app.get('/api/devdash/services', async () => registry.get());

  app.post('/api/devdash/services', async (req) => {
    const saved = registry.add(req.body);
    cache.clear();
    return saved;
  });

  app.put<{ Params: { name: string } }>('/api/devdash/services/:name', async (req) => {
    const saved = registry.put(req.params.name, req.body);
    cache.clear();
    return saved;
  });

  app.delete<{ Params: { name: string } }>('/api/devdash/services/:name', async (req, reply) => {
    if (!registry.remove(req.params.name)) return reply.status(404).send({ error: `Nothing named "${req.params.name}" is tracked` });
    cache.clear();
    return { ok: true };
  });

  // Live logs as server-sent events: {text, err} per line. Only tracked containers.
  app.get<{ Params: { name: string }; Querystring: { since?: string } }>('/api/devdash/logs/:name', async (req, reply) => {
    const name = req.params.name;
    if (!registry.containers().has(name)) return reply.status(404).send({ error: `${name} isn't tracked` });
    const c = (await docker.list()).find((x) => x.Names.some((n) => n.replace(/^\//, '') === name));
    if (!c) return reply.status(404).send({ error: `No container named ${name}` });
    const i = await docker.inspect(c.Id);
    const since = Math.floor(Date.now() / 1000) - (SINCE[req.query.since ?? ''] ?? SINCE['2h']);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.write(': open\n\n');
    let stream: Awaited<ReturnType<Docker['follow']>> | null = null;
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const stop = () => {
      clearInterval(ping);
      stream?.destroy();
      if (!res.writableEnded) res.end();
    };
    req.raw.on('close', stop);
    try {
      stream = await docker.follow(c.Id, i.Config?.Tty ?? false, since, (l) => res.write(`data: ${JSON.stringify(l)}\n\n`));
      if (res.destroyed) stop();
      stream.on('end', stop);
      stream.on('error', stop);
    } catch (err) {
      res.write(`event: fail\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
      stop();
    }
  });

  return { registry };
}
