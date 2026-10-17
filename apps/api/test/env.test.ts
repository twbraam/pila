import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/env.js";

const base = {};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      host: "0.0.0.0",
      port: 8787,
      apiTokens: [],
      allowedOrigins: [],
      rateLimitPerMinute: 20,
      cacheTtlMs: 6 * 60 * 60 * 1000,
      cacheMaxEntries: 500,
      requestTimeoutMs: 55_000,
      maxBodyBytes: 16_384,
      trustProxy: false,
      trustedProxyHops: 1,
      originSecret: undefined,
      transcriptSource: "mock",
      factCheckSource: "mock",
      production: false,
    });
  });

  it("reads lists, numbers, and flags", () => {
    const config = loadConfig({
      ...base,
      PORT: "9000",
      PILA_API_TOKENS: " a , b ,,",
      ALLOWED_ORIGINS: "chrome-extension://abc",
      RATE_LIMIT_PER_MINUTE: "5",
      TRUST_PROXY: "true",
      ORIGIN_VERIFY_SECRET: "cf",
    });
    expect(config).toMatchObject({
      port: 9000,
      apiTokens: ["a", "b"],
      allowedOrigins: ["chrome-extension://abc"],
      rateLimitPerMinute: 5,
      trustProxy: true,
      originSecret: "cf",
    });
  });

  it("requires API tokens in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/PILA_API_TOKENS/);
    expect(loadConfig({ ...base, NODE_ENV: "production", PILA_API_TOKENS: "t" }).production).toBe(true);
  });

  it("rejects an unknown transcript source", () => {
    expect(() => loadConfig({ ...base, TRANSCRIPT_SOURCE: "nope" })).toThrow(/TRANSCRIPT_SOURCE/);
  });

  it("rejects an unknown fact-check source", () => {
    expect(() => loadConfig({ ...base, FACTCHECK_SOURCE: "nope" })).toThrow(/FACTCHECK_SOURCE/);
  });

  it("rejects bad numbers", () => {
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, RATE_LIMIT_PER_MINUTE: "0" })).toThrow(/RATE_LIMIT_PER_MINUTE/);
  });

  it("never puts key values in error messages", () => {
    const error = (() => {
      try {
        loadConfig({ ORIGIN_VERIFY_SECRET: "secret-value", PORT: "x" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).not.toContain("secret-value");
  });
});
