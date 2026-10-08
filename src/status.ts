import { TtlCache } from './cache';

export type LinkStatus = 'ok' | 'slow' | 'down';

const SLOW_MS = 1500;
const cache = new TtlCache<LinkStatus>(60_000);

/**
 * Inside the container, the Tailscale name `synology` doesn't resolve, so NAS links are probed
 * via the NAS's LAN address instead.
 */
export function probeUrl(url: string, nasHost: string): string {
  const u = new URL(url);
  if (u.hostname === 'synology') u.hostname = nasHost;
  return u.toString();
}

async function probe(url: string): Promise<LinkStatus> {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    if (res.status >= 500) return 'down';
    return Date.now() - started > SLOW_MS ? 'slow' : 'ok';
  } catch {
    return 'down';
  }
}

export async function linkStatuses(urls: string[], nasHost: string): Promise<Record<string, LinkStatus>> {
  const results = await Promise.all(urls.map((u) => cache.get(u, () => probe(probeUrl(u, nasHost)))));
  return Object.fromEntries(urls.map((u, i) => [u, results[i]]));
}
