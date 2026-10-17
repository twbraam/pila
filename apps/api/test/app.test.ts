import {
  AuthError,
  type ClaimResult,
  type FactCheckOptions,
  type FactCheckResult,
  QuotaError,
  RateLimitError,
  type Transcript,
  type TranscriptSegment,
  UpstreamError,
} from "@pila/factcheck";
import { type GetTranscript, TranscriptNotFoundError } from "../src/transcripts/index.js";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type ApiConfig, loadConfig } from "../src/env.js";

const videoId = "OwqIy8Ikv-c";
const segments: TranscriptSegment[] = [
  { text: "There is no evidence that CO2 is the dominant factor.", start: 104.7, duration: 7.1 },
  { text: "The climate is always changing.", start: 121.2, duration: 2.7 },
];
const ids = [`${videoId}-0`, `${videoId}-1`];

type GetTranscriptFn = GetTranscript;
const fakeTranscripts = (impl?: GetTranscriptFn) => vi.fn(impl ?? (async (id: string) => ({ videoId: id, segments })));

const result = (sentenceId: string): FactCheckResult => ({
  videoId,
  sentenceId,
  startSeconds: 104.7,
  endSeconds: 111.8,
  sentence: "There is no evidence that CO2 is the dominant factor.",
  verdict: "misinformation",
  confidence: 0.93,
  explanation: "Science Feedback says this claim is false: “This is false.”",
  sources: [{ title: "Science Feedback review", url: "https://science.feedback.org/review/x" }],
});

const detail = (error?: ClaimResult["error"]): ClaimResult => ({
  claim: { index: 0, start: 104.7, text: "x", checkable: 0.9, suspicious: 0.8 },
  label: "false",
  confidence: 0.93,
  sources: [],
  ...(error ? { error } : {}),
});

type FactCheck = (t: Transcript, o?: FactCheckOptions) => Promise<FactCheckResult[]>;

/** A checker that streams one result per sentence, like the real one. */
const streamingChecker = (options: { failClaim?: boolean; delayMs?: number } = {}): FactCheck =>
  vi.fn(async (t: Transcript, o?: FactCheckOptions) => {
    const results = t.sentences.map((s) => result(s.id));
    for (const r of results) {
      if (options.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          o?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("cancelled"), { name: "CancelledError" }));
          });
        });
      }
      o?.onResult?.(r, detail(options.failClaim ? { name: "UpstreamError", message: "boom" } : undefined));
    }
    return results;
  });

const failingChecker = (error: Error): FactCheck => vi.fn(async () => Promise.reject(error));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const setup = (factCheck: FactCheck = streamingChecker(), env: Record<string, string> = {}, getTranscript = fakeTranscripts()) => {
  const config: ApiConfig = loadConfig({ TYPESAFE_API_KEY: "k", PILA_API_TOKENS: "good-token", TRUST_PROXY: "true", ...env });
  const app = createApp({ checker: { factCheck }, config, logger, transcripts: { get: getTranscript, source: "fake" } });
  return { app, factCheck, getTranscript };
};

const post = (app: ReturnType<typeof setup>["app"], body: unknown, headers: Record<string, string> = {}) =>
  app.request("/factcheck", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer good-token", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const sseEvents = (text: string) =>
  text
    .trim()
    .split("\n\n")
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null"),
    }));

describe("GET /health", () => {
  it("needs no token", async () => {
    const res = await setup().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { ok: true }, error: null });
  });
});

describe("origin check", () => {
  const env = { ORIGIN_VERIFY_SECRET: "cf-secret" };

  it("rejects requests without the CloudFront header with 403, health included", async () => {
    const { app } = setup(streamingChecker(), env);
    for (const res of [await app.request("/health"), await post(app, { videoId }), await post(app, { videoId }, { "x-origin-verify": "wrong" })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ success: false, error: { code: "forbidden" } });
    }
  });

  it("lets requests with the right header through", async () => {
    const { app } = setup(streamingChecker(), env);
    expect((await app.request("/health", { headers: { "x-origin-verify": "cf-secret" } })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-origin-verify": "cf-secret" })).status).toBe(200);
  });
});

describe("POST /factcheck", () => {
  it("returns results in the response envelope", async () => {
    const { app, factCheck } = setup();
    const res = await post(app, { videoId, video: { title: "Climate Change", channel: "PragerU" }, language: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-pila-cache")).toBe("miss");
    expect(await res.json()).toEqual({ success: true, data: [result(ids[0]!), result(ids[1]!)], error: null });
    const [checked, options] = vi.mocked(factCheck).mock.calls[0]!;
    expect(checked).toEqual({
      videoId,
      sentences: [
        { id: ids[0], text: segments[0]!.text, startSeconds: 104.7, endSeconds: 111.8 },
        { id: ids[1], text: segments[1]!.text, startSeconds: 121.2, endSeconds: 123.9 },
      ],
    });
    expect(options).toMatchObject({ video: { title: "Climate Change", channel: "PragerU" }, language: "en" });
    expect(res.headers.get("x-pila-transcript-source")).toBe("fake");
  });

  it("fetches the transcript by video ID, with the request's signal", async () => {
    const { app, getTranscript } = setup();
    await post(app, { videoId });
    expect(getTranscript).toHaveBeenCalledWith(videoId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("uses the transcript's language when the request doesn't set one", async () => {
    const chinese = [{ text: "没有证据表明二氧化碳排放是主要因素。", start: 107.8, duration: 4 }];
    const { app, factCheck } = setup(streamingChecker(), {}, fakeTranscripts(async (id) => ({ videoId: id, segments: chinese, language: "zh" })));
    await post(app, { videoId });
    expect(vi.mocked(factCheck).mock.calls[0]?.[1]).toMatchObject({ language: "zh" });
  });

  it.each([
    ["has no transcript", async () => Promise.reject(new TranscriptNotFoundError("no captions")), 404, "transcript_not_found"],
    ["fails", async () => Promise.reject(new Error("youtube down: internal detail")), 502, "transcript_unavailable"],
    ["returns bad segments", async (id: string) => ({ videoId: id, segments: [{ text: 1 }] as never }), 502, "transcript_unavailable"],
    ["returns no text", async (id: string) => ({ videoId: id, segments: [{ text: "", start: 0, duration: 1 }] }), 404, "transcript_not_found"],
  ])("answers %s with a safe error", async (_name, impl, status, code) => {
    const { app, factCheck } = setup(streamingChecker(), {}, fakeTranscripts(impl as GetTranscriptFn));
    const res = await post(app, { videoId });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code } });
    expect(body.error.message).not.toContain("internal detail");
    expect(factCheck).not.toHaveBeenCalled();
  });

  it("answers 502 when the transcript function rejects with no error object", async () => {
    const { app } = setup(streamingChecker(), {}, fakeTranscripts(async () => Promise.reject(undefined)));
    const res = await post(app, { videoId });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "transcript_unavailable" } });
  });

  it("answers 502 when the transcript is for a different video", async () => {
    const { app, factCheck } = setup(streamingChecker(), {}, fakeTranscripts(async () => ({ videoId: "dQw4w9WgXcQ", segments })));
    expect((await post(app, { videoId })).status).toBe(502);
    expect(factCheck).not.toHaveBeenCalled();
  });

  it("returns real HTTP statuses for transcript errors on the streaming path too", async () => {
    const { app } = setup(streamingChecker(), {}, fakeTranscripts(async () => Promise.reject(new TranscriptNotFoundError())));
    const res = await post(app, { videoId }, { accept: "text/event-stream" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "transcript_not_found" } });
  });

  it("logs a transcript failure once, with the original error", async () => {
    logger.error.mockClear();
    const { app } = setup(streamingChecker(), {}, fakeTranscripts(async () => Promise.reject(new Error("socket hang up"))));
    await post(app, { videoId });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain("socket hang up");
  });

  it("detects the language once and passes it to the fact check", async () => {
    const chinese = [{ text: "没有证据表明二氧化碳排放是主要因素。", start: 107.8, duration: 4 }];
    const { app, factCheck } = setup(streamingChecker(), {}, fakeTranscripts(async (id) => ({ videoId: id, segments: chinese })));
    await post(app, { videoId });
    expect(vi.mocked(factCheck).mock.calls[0]?.[1]).toMatchObject({ language: "zh" });
  });

  it("does not fetch the transcript again on a cache hit", async () => {
    const { app, getTranscript } = setup();
    await post(app, { videoId });
    await post(app, { videoId });
    expect(getTranscript).toHaveBeenCalledOnce();
  });

  it("streams results as server-sent events when asked", async () => {
    const res = await post(setup().app, { videoId }, { accept: "text/event-stream" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(sseEvents(await res.text())).toEqual([
      { event: "result", data: result(ids[0]!) },
      { event: "result", data: result(ids[1]!) },
      { event: "done", data: { videoId, count: 2, cached: false } },
    ]);
  });

  it("serves a repeated request from the cache", async () => {
    const { app, factCheck } = setup();
    await post(app, { videoId });
    const res = await post(app, { videoId });
    expect(res.headers.get("x-pila-cache")).toBe("hit");
    expect((await res.json()).data).toHaveLength(2);
    const streamed = sseEvents(await (await post(app, { videoId }, { accept: "text/event-stream" })).text());
    expect(streamed.at(-1)).toEqual({ event: "done", data: { videoId, count: 2, cached: true } });
    expect(factCheck).toHaveBeenCalledTimes(1);
  });

  it("does not cache runs where a claim failed", async () => {
    const { app, factCheck } = setup(streamingChecker({ failClaim: true }));
    await post(app, { videoId });
    await post(app, { videoId });
    expect(factCheck).toHaveBeenCalledTimes(2);
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
    expect(await res.json()).toMatchObject({ success: false, data: null, error: { code: "unauthorized" } });
  });

  it("allows requests without a token when no tokens are configured", async () => {
    const { app } = setup(streamingChecker(), { PILA_API_TOKENS: "" });
    const res = await app.request("/factcheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ["invalid JSON", "{nope", "invalid_json"],
    ["a missing videoId", { video: {} }, "invalid_request"],
    ["an invalid videoId", { videoId: "https://youtu.be/OwqIy8Ikv-c" }, "invalid_request"],
    ["the old transcript body", { transcript: { videoId, sentences: [] } }, "invalid_request"],
    ["an unknown language", { videoId, language: "fr" }, "invalid_request"],
  ])("rejects %s with 400", async (_name, body, code) => {
    const { app, factCheck } = setup();
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: { code } });
    expect(factCheck).not.toHaveBeenCalled();
  });

  it("rejects streamed bodies over the size limit with 413, not 400", async () => {
    const { app } = setup(streamingChecker(), { MAX_BODY_BYTES: "100" });
    const chunk = new TextEncoder().encode(JSON.stringify({ videoId, video: { title: "x".repeat(200) } }));
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

  it("rejects bodies over the size limit with 413", async () => {
    const { app } = setup(streamingChecker(), { MAX_BODY_BYTES: "100" });
    const res = await post(app, { videoId, video: { title: "x".repeat(200) } });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("rate limits each client separately even when they share a token", async () => {
    const { app } = setup(streamingChecker(), { RATE_LIMIT_PER_MINUTE: "1" });
    expect((await post(app, { videoId }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-forwarded-for": "198.51.100.2" })).status).toBe(200);
    expect((await post(app, { videoId }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(429);
  });

  it("ignores client-supplied X-Forwarded-For entries before the trusted proxy's", async () => {
    const { app } = setup(streamingChecker(), { RATE_LIMIT_PER_MINUTE: "1" });
    expect((await post(app, { videoId }, { "x-forwarded-for": "10.0.0.1, 198.51.100.7" })).status).toBe(200);
    // A spoofed first entry does not create a new bucket: the last (proxy-added) entry is the client.
    expect((await post(app, { videoId }, { "x-forwarded-for": "10.0.0.99, 198.51.100.7" })).status).toBe(429);
  });

  it("prefers CloudFront-Viewer-Address for the client IP", async () => {
    const { app } = setup(streamingChecker(), { RATE_LIMIT_PER_MINUTE: "1" });
    const viewer = (address: string, xff: string) => ({ "cloudfront-viewer-address": address, "x-forwarded-for": xff });
    expect((await post(app, { videoId }, viewer("2001:db8::1:443", "1.1.1.1"))).status).toBe(200);
    expect((await post(app, { videoId }, viewer("2001:db8::1:51000", "2.2.2.2"))).status).toBe(429);
    expect((await post(app, { videoId }, viewer("203.0.113.9:443", "1.1.1.1"))).status).toBe(200);
  });

  it("rate limits per token", async () => {
    const { app } = setup(streamingChecker(), { RATE_LIMIT_PER_MINUTE: "2" });
    expect((await post(app, { videoId })).status).toBe(200);
    expect((await post(app, { videoId })).status).toBe(200);
    const limited = await post(app, { videoId });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it.each([
    [new QuotaError("Tavily plan or credit limit reached", { service: "tavily", status: 432 }), 503, "upstream_quota"],
    [new AuthError("Jev rejected the API key", { service: "jev", status: 401 }), 502, "upstream_misconfigured"],
    [new Error("database exploded with secret details"), 500, "internal_error"],
    [new RateLimitError("Jev rate limit reached", { service: "jev", status: 429 }), 503, "upstream_busy"],
    [new UpstreamError("Could not reach Tavily", { service: "tavily" }), 502, "upstream_error"],
  ])("maps %o to a safe %i response", async (error, status, code) => {
    const res = await post(setup(failingChecker(error)).app, { videoId });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, data: null, error: { code } });
    expect(body.error.message).not.toContain("secret");
    expect(body.error.message).not.toContain("API key");
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  it("sends an error event when a streamed run fails", async () => {
    const res = await post(setup(failingChecker(new QuotaError("q", { service: "tavily" }))).app, { videoId }, { accept: "text/event-stream" });
    expect(sseEvents(await res.text())).toEqual([
      { event: "error", data: { code: "upstream_quota", message: expect.any(String), requestId: expect.any(String) } },
    ]);
  });

  it("times out slow runs with 504", async () => {
    const { app } = setup(streamingChecker({ delayMs: 500 }), { REQUEST_TIMEOUT_SECONDS: "0.05" });
    const res = await post(app, { videoId });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: "timeout" } });
  });

  it("allows any origin when configured with *", async () => {
    const { app } = setup(streamingChecker(), { ALLOWED_ORIGINS: "*" });
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
    const { app } = setup(streamingChecker(), { ALLOWED_ORIGINS: "*" });
    const res = await post(app, { videoId }, { origin: "chrome-extension://x", authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("allows CORS only for configured origins", async () => {
    const { app } = setup(streamingChecker(), { ALLOWED_ORIGINS: "chrome-extension://abc" });
    const allowed = await post(app, { videoId }, { origin: "chrome-extension://abc" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
    const other = await post(app, { videoId: "v2v2v2v2v2v" }, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns 404 in the envelope for unknown routes", async () => {
    const res = await setup().app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("never logs the bearer token", async () => {
    const { app } = setup();
    await post(app, { videoId });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain("good-token");
  });
});
