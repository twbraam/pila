import { describe, expect, it } from "vitest";
import { createTtlCache } from "../src/cache.js";
import { createRateLimiter } from "../src/rate-limit.js";

const clock = (start = 0) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe("createTtlCache", () => {
  it("returns values until they expire", () => {
    const time = clock();
    const cache = createTtlCache<string>({ ttlMs: 1000, maxEntries: 10, now: time.now });
    cache.set("a", "1");
    expect(cache.get("a")).toBe("1");
    time.advance(1001);
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the least recently used entry when full", () => {
    const cache = createTtlCache<number>({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
    expect(cache.size()).toBe(2);
  });
});

describe("createRateLimiter", () => {
  it("sweeps expired windows once the map is large", () => {
    const time = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: time.now, sweepAt: 2 });
    limiter.take("a");
    limiter.take("b");
    expect(limiter.size()).toBe(2);
    time.advance(1000);
    limiter.take("c");
    expect(limiter.size()).toBe(1);
  });

  it("allows up to the limit per window, then reports when to retry", () => {
    const time = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: time.now });
    expect(limiter.take("k").allowed).toBe(true);
    expect(limiter.take("k").allowed).toBe(true);
    time.advance(15_000);
    expect(limiter.take("k")).toEqual({ allowed: false, retryAfterSeconds: 45 });
    expect(limiter.take("other").allowed).toBe(true);
    time.advance(45_000);
    expect(limiter.take("k").allowed).toBe(true);
  });
});
