export type RateDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  take(key: string): RateDecision;
  size(): number;
}

/** Windows kept before old ones are swept, so the map can't grow without bound. */
const SWEEP_AT = 10_000;

/** Fixed-window limiter per key, in memory. Good enough for one instance; use a shared store to scale out. */
export function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number; sweepAt?: number }): RateLimiter {
  const now = options.now ?? Date.now;
  const sweepAt = options.sweepAt ?? SWEEP_AT;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  /** At most once per window, so a burst of fresh keys can't make every request scan the map. */
  const sweep = (time: number) => {
    if (time - lastSweep < options.windowMs) return;
    lastSweep = time;
    for (const [key, w] of windows) if (time - w.start >= options.windowMs) windows.delete(key);
  };

  return {
    size: () => windows.size,
    take(key) {
      const time = now();
      if (windows.size >= sweepAt) sweep(time);
      const current = windows.get(key);
      if (!current || time - current.start >= options.windowMs) {
        windows.set(key, { start: time, count: 1 });
        return { allowed: true };
      }
      if (current.count < options.limit) {
        windows.set(key, { ...current, count: current.count + 1 });
        return { allowed: true };
      }
      return { allowed: false, retryAfterSeconds: Math.ceil((current.start + options.windowMs - time) / 1000) };
    },
  };
}
