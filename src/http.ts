/** Thrown when a third-party service (Unsplash, ESPN, Yahoo) fails. Routes turn it into a 502. */
export class UpstreamError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function getJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpstreamError(`${new URL(url).host} unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new UpstreamError(`${new URL(url).host} returned ${res.status}`, res.status);
  return res.json() as Promise<T>;
}
