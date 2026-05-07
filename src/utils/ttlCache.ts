// Tiny in-process TTL cache for read-through use on Firestore rollup fetches.
//
// The /reports page fires three identical-or-overlapping fetchRange calls in
// rapid succession (summary, timeseries, per-offer / per-network). With a
// 60s TTL those collapse to a single Firestore round-trip per range. The
// rollup data is itself eventually-consistent (writes are FieldValue.increment
// from hot paths, the frontend uses staleTime: 30s), so a 60s server-side
// cache is invisible to operators.
//
// Single-process only — fine for our deployment shape. If we move to multiple
// instances behind a load balancer, swap this for memorystore/redis.

interface Entry<V> {
  value: V;
  expiresAt: number;
  inflight?: Promise<V>;
}

export interface TTLCacheOptions {
  ttlMs: number;
  maxEntries?: number;
}

export class TTLCache<V> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, Entry<V>>();

  constructor(opts: TTLCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 256;
  }

  // Returns the cached value if fresh; otherwise calls `loader` (de-duplicated
  // across concurrent callers — a request burst on a cold key produces one
  // upstream call, not N).
  async getOrLoad(key: string, loader: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (hit?.inflight) return hit.inflight;

    const inflight = loader().then(
      (value) => {
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        this.evictIfFull();
        return value;
      },
      (err) => {
        // On failure, drop the inflight marker so the next caller retries.
        this.store.delete(key);
        throw err;
      }
    );
    this.store.set(key, {
      value: hit?.value as V,
      expiresAt: hit?.expiresAt ?? 0,
      inflight,
    });
    return inflight;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  private evictIfFull(): void {
    if (this.store.size <= this.maxEntries) return;
    // Drop the oldest insertion (Map preserves insertion order). Good enough
    // for a small cache where keys naturally roll over with the date window.
    const firstKey = this.store.keys().next().value;
    if (firstKey !== undefined) this.store.delete(firstKey);
  }
}
