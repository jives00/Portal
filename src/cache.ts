type Entry<T> = { value: T; at: number };

/**
 * Small in-memory TTL cache. Concurrent misses share one load, and when a reload
 * fails the last good value is served instead (a home page should show stale data, not errors).
 */
export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(private ttlMs: number) {}

  async get(key: string, load: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = load()
        .then((value) => {
          this.entries.set(key, { value, at: Date.now() });
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      return await pending;
    } catch (err) {
      if (hit) return hit.value;
      throw err;
    }
  }
}
