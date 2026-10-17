import type { TranscriptSegment } from "@pila/factcheck";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type ApiConfig, loadConfig } from "../src/env.js";
import type { FactCheckFn, FactCheckItem } from "../src/factcheck/index.js";
import { type GetTranscript, TranscriptNotFoundError } from "../src/transcripts/index.js";

const videoId = "OwqIy8Ikv-c";
const segments: TranscriptSegment[] = [
  { text: "There is no evidence that CO2 is the dominant factor.", start: 104.7, duration: 7.1 },
  { text: "The climate is always changing.", start: 121.2, duration: 2.7 },
];

const items: FactCheckItem[] = [
  { timestamp: 104.7, sentence: "There is no evidence that CO2 is the dominant factor.", score: 3, sources: ["https://science.feedback.org/review/x"] },
  { timestamp: 121.2, sentence: "The climate is always changing.", score: 0, sources: [] },
];

const fakeTranscripts = (impl?: GetTranscript) => vi.fn(impl ?? (async (id: string) => ({ videoId: id, segments })));

const fakeFactCheck = (impl?: FactCheckFn) => vi.fn(impl ?? (async () => items));

/** A fact check that waits `ms`, or rejects when the signal aborts. */
const slowFactCheck = (ms: number) =>
  fakeFactCheck(
    (_t, o) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(items), ms);
        o?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(o.signal?.reason);
        });
      }),
  );

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const setup = (factCheck = fakeFactCheck(), env: Record<string, string> = {}, getTranscript = fakeTranscripts()) => {
  const config: ApiConfig = loadConfig({ PILA_API_TOKENS: "good-token", TRUST_PROXY: "true", ...env });
  const app = createApp({
    config,
    logger,
    transcripts: { get: getTranscript, source: "fake-transcript" },
    factCheck: { run: factCheck, source: "fake-check" },
  });
  return { app, factCheck, getTranscript };
};

const post = (app: ReturnType<typeof setup>["app"], body: unknown, headers: Record<string, string> = {}) =>
  app.request("/factcheck", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer good-token", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("GET /health", () => {
  it("needs no token", async () => {
    const res = await setup().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("origin check", () => {
  const env = { ORIGIN_VERIFY_SECRET: "cf-secret" };

  it("rejects requests without the CloudFront header with 403, health included", async () => {
    const { app } = setup(fakeFactCheck(), env);
    for (const res of [await app.request("/health"), await post(app, { videoId }), await post(app, { videoId }, { "x-origin-verify": "wrong" })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    }
  });

  it("lets requests with the right header through", async () => {
    const { app } = setup(fakeFactCheck(), env);
    expect((await app.request("/health", { headers: { "x-origin-verify": "cf-secret" } })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-origin-verify": "cf-secret" })).status).toBe(200);
  });
});

describe("POST /factcheck", () => {
  it("returns the fact-check items as a bare array", async () => {
    const { app } = setup();
    const res = await post(app, { videoId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(items);
    expect(res.headers.get("x-pila-cache")).toBe("miss");
    expect(res.headers.get("x-pila-transcript-source")).toBe("fake-transcript");
    expect(res.headers.get("x-pila-factcheck-source")).toBe("fake-check");
  });

  it("passes the transcript function's result to the fact-check function, with the request's signal", async () => {
    const { app, factCheck, getTranscript } = setup();
    await post(app, { videoId });
    expect(getTranscript).toHaveBeenCalledWith(videoId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(factCheck).toHaveBeenCalledWith({ videoId, segments }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps only the contract fields of each item", async () => {
    const { app } = setup(fakeFactCheck(async () => items.map((i) => ({ ...i, internal: "x" }))));
    expect(await (await post(app, { videoId })).json()).toEqual(items);
  });

  it.each([
    ["has no transcript", async () => Promise.reject(new TranscriptNotFoundError("no captions")), 404, "transcript_not_found"],
    ["fails", async () => Promise.reject(new Error("youtube down: internal detail")), 502, "transcript_unavailable"],
    ["rejects with no error object", async () => Promise.reject(undefined), 502, "transcript_unavailable"],
    ["returns bad segments", async (id: string) => ({ videoId: id, segments: [{ text: 1 }] as never }), 502, "transcript_unavailable"],
    ["returns another video", async () => ({ videoId: "dQw4w9WgXcQ", segments }), 502, "transcript_unavailable"],
    ["returns no text", async (id: string) => ({ videoId: id, segments: [{ text: " ", start: 0, duration: 1 }] }), 404, "transcript_not_found"],
  ])("answers when the transcript function %s", async (_name, impl, status, code) => {
    const { app, factCheck } = setup(fakeFactCheck(), {}, fakeTranscripts(impl as GetTranscript));
    const res = await post(app, { videoId });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code } });
    expect(body.error.message).not.toContain("internal detail");
    expect(factCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", async () => Promise.reject(new Error("model down: internal detail"))],
    ["returns a bad score", async () => [{ ...items[0], score: 7 }]],
    ["returns a non-array", async () => ({ items })],
  ])("answers 502 factcheck_failed when the fact-check function %s", async (_name, impl) => {
    const { app } = setup(fakeFactCheck(impl as FactCheckFn));
    const res = await post(app, { videoId });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: "factcheck_failed", requestId: expect.any(String) } });
    expect(body.error.message).not.toContain("internal detail");
  });

  it("logs a failure once, with the original error", async () => {
    logger.error.mockClear();
    const { app } = setup(fakeFactCheck(), {}, fakeTranscripts(async () => Promise.reject(new Error("socket hang up"))));
    await post(app, { videoId });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain("socket hang up");
  });

  it("serves a repeated video from the cache", async () => {
    const { app, factCheck, getTranscript } = setup();
    await post(app, { videoId });
    const res = await post(app, { videoId });
    expect(res.headers.get("x-pila-cache")).toBe("hit");
    expect(await res.json()).toEqual(items);
    expect(getTranscript).toHaveBeenCalledOnce();
    expect(factCheck).toHaveBeenCalledOnce();
  });

  it("times out slow runs with 504", async () => {
    const { app } = setup(slowFactCheck(500), { REQUEST_TIMEOUT_SECONDS: "0.05" });
    const res = await post(app, { videoId });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: "timeout" } });
  });

  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: "Bearer nope" }],
    ["a malformed header", { authorization: "good-token" }],
  ])("rejects %s with 401", async (_name, headers) => {
    const res = await setup().app.request("/factcheck", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ videoId }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("allows requests without a token when no tokens are configured", async () => {
    const { app } = setup(fakeFactCheck(), { PILA_API_TOKENS: "" });
    const res = await app.request("/factcheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ["invalid JSON", "{nope", "invalid_json"],
    ["a non-object body", "[1]", "invalid_request"],
    ["a missing videoId", {}, "invalid_request"],
    ["an invalid videoId", { videoId: "https://youtu.be/OwqIy8Ikv-c" }, "invalid_request"],
  ])("rejects %s with 400", async (_name, body, code) => {
    const { app, factCheck } = setup();
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
    expect(factCheck).not.toHaveBeenCalled();
  });

  it("rejects bodies over the size limit with 413", async () => {
    const { app } = setup(fakeFactCheck(), { MAX_BODY_BYTES: "100" });
    const res = await post(app, { videoId, padding: "x".repeat(200) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("rejects streamed bodies over the size limit with 413, not 400", async () => {
    const { app } = setup(fakeFactCheck(), { MAX_BODY_BYTES: "100" });
    const chunk = new TextEncoder().encode(JSON.stringify({ videoId, padding: "x".repeat(200) }));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await app.request("/factcheck", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("rate limits per token", async () => {
    const { app } = setup(fakeFactCheck(), { RATE_LIMIT_PER_MINUTE: "2" });
    expect((await post(app, { videoId })).status).toBe(200);
    expect((await post(app, { videoId })).status).toBe(200);
    const limited = await post(app, { videoId });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("rate limits each client separately even when they share a token", async () => {
    const { app } = setup(fakeFactCheck(), { RATE_LIMIT_PER_MINUTE: "1" });
    expect((await post(app, { videoId }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-forwarded-for": "198.51.100.2" })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(429);
  });

  it("ignores client-supplied X-Forwarded-For entries before the trusted proxy's", async () => {
    const { app } = setup(fakeFactCheck(), { RATE_LIMIT_PER_MINUTE: "1" });
    expect((await post(app, { videoId }, { "x-forwarded-for": "10.0.0.1, 198.51.100.7" })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-forwarded-for": "10.0.0.99, 198.51.100.7" })).status).toBe(429);
  });

  it("prefers CloudFront-Viewer-Address for the client IP", async () => {
    const { app } = setup(fakeFactCheck(), { RATE_LIMIT_PER_MINUTE: "1" });
    const viewer = (address: string, xff: string) => ({ "cloudfront-viewer-address": address, "x-forwarded-for": xff });
    expect((await post(app, { videoId }, viewer("2001:db8::1:443", "1.1.1.1"))).status).toBe(200);
    expect((await post(app, { videoId }, viewer("2001:db8::1:51000", "2.2.2.2"))).status).toBe(429);
    expect((await post(app, { videoId }, viewer("203.0.113.9:443", "1.1.1.1"))).status).toBe(200);
  });

  it("allows any origin when configured with *", async () => {
    const { app } = setup(fakeFactCheck(), { ALLOWED_ORIGINS: "*" });
    const res = await post(app, { videoId }, { origin: "chrome-extension://anything" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await app.request("/factcheck", {
      method: "OPTIONS",
      headers: { origin: "chrome-extension://x", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
  });

  it("adds CORS headers to error responses too", async () => {
    const { app } = setup(fakeFactCheck(), { ALLOWED_ORIGINS: "*" });
    const res = await post(app, { videoId }, { origin: "chrome-extension://x", authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("allows CORS only for configured origins", async () => {
    const { app } = setup(fakeFactCheck(), { ALLOWED_ORIGINS: "chrome-extension://abc" });
    const allowed = await post(app, { videoId }, { origin: "chrome-extension://abc" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
    const other = await post(app, { videoId: "v2v2v2v2v2v" }, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns 404 for unknown routes", async () => {
    const res = await setup().app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("never logs the bearer token", async () => {
    const { app } = setup();
    await post(app, { videoId });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain("good-token");
  });
});
