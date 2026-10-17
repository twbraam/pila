export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  size(): number;
}

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

/** In-memory cache with a time-to-live and least-recently-used eviction. One per server process. */
export function createTtlCache<V>(options: { ttlMs: number; maxEntries: number; now?: () => number }): TtlCache<V> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<V>>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= now()) return undefined;
      entries.set(key, entry); // re-insert to mark as most recently used
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + options.ttlMs });
      for (const oldest of entries.keys()) {
        if (entries.size <= options.maxEntries) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
  };
}
