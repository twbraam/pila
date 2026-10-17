import { createHash, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  detectLanguage,
  type FactChecker,
  type FactCheckResult,
  InvalidInputError,
  type Language,
  parseTranscript,
  segmentsToTranscript,
  type Transcript,
  type TranscriptSegment,
} from "@pila/factcheck";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { createTtlCache } from "./cache.js";
import type { ApiConfig } from "./env.js";
import { errorInfo, fail, HttpError, ok, toHttpError } from "./http.js";
import { createRateLimiter } from "./rate-limit.js";
import { type GetTranscript, isYouTubeVideoId, TranscriptNotFoundError } from "./transcripts/index.js";

export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface AppDeps {
  readonly checker: Pick<FactChecker, "factCheck">;
  readonly config: ApiConfig;
  readonly logger: Logger;
  /** The transcript function and its name (sent as `x-pila-transcript-source`). */
  readonly transcripts: { readonly get: GetTranscript; readonly source: string };
}

interface LoadedTranscript {
  readonly transcript: Transcript;
  readonly language: Language;
}

interface FactCheckRequest {
  readonly videoId: string;
  readonly video: { readonly title?: string; readonly channel?: string } | undefined;
  readonly language: Language | undefined;
}

type Env = { Variables: RequestIdVariables & { clientKey: string; ipSource: string } };

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** Constant-time string comparison (via fixed-length digests). */
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/** `cached` is a header so the body stays the deployed contract: `data: FactCheckResult[]`. */
const CACHE_HEADER = "x-pila-cache";
/** Tells clients whether results came from the mock transcript. */
const TRANSCRIPT_SOURCE_HEADER = "x-pila-transcript-source";

const optionalText = (value: unknown, name: string, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new InvalidInputError(`${name} must be a string of at most ${max} characters`);
  return value;
};

/** Validate the request body before any work (or any streamed bytes) starts. */
function parseRequest(body: unknown): FactCheckRequest {
  if (typeof body !== "object" || body === null) throw new InvalidInputError("The body must be a JSON object");
  const { videoId, video, language } = body as Record<string, unknown>;
  if (videoId === undefined) throw new InvalidInputError("videoId is required");
  if (!isYouTubeVideoId(videoId)) throw new InvalidInputError("videoId must be an 11-character YouTube video ID");
  if (video !== undefined && (typeof video !== "object" || video === null)) throw new InvalidInputError("video must be an object");
  if (language !== undefined && language !== "en" && language !== "zh") throw new InvalidInputError('language must be "en" or "zh"');
  const v = (video ?? {}) as Record<string, unknown>;
  const title = optionalText(v.title, "video.title", 500);
  const channel = optionalText(v.channel, "video.channel", 200);
  return {
    videoId,
    video: video === undefined ? undefined : { ...(title ? { title } : {}), ...(channel ? { channel } : {}) },
    language,
  };
}

const cacheKey = (request: FactCheckRequest) => sha256(JSON.stringify(request)).toString("hex");

export function createApp({ checker, config, logger, transcripts }: AppDeps) {
  const app = new Hono<Env>();
  const cache = createTtlCache<FactCheckResult[]>({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });
  const limiter = createRateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000 });
  const tokenDigests = config.apiTokens.map(sha256);

  const errorResponse = (c: Context<Env>, error: HttpError) => {
    if (error.retryAfterSeconds !== undefined) c.header("Retry-After", String(error.retryAfterSeconds));
    const body = fail({ code: error.code, message: error.message, requestId: c.get("requestId") });
    return c.json(body, error.status as ContentfulStatusCode);
  };

  /**
   * The client IP. Behind a trusted proxy: CloudFront's own `CloudFront-Viewer-Address` ("ip:port"),
   * else the `X-Forwarded-For` entry the nearest trusted proxy appended. Earlier entries are
   * client-supplied and spoofable, so they are never used.
   */
  const clientIp = (c: Context<Env>): { ip: string; source: string } => {
    if (config.trustProxy) {
      const viewer = c.req.header("cloudfront-viewer-address")?.trim();
      const port = viewer?.lastIndexOf(":") ?? -1;
      if (viewer && port > 0) return { ip: viewer.slice(0, port), source: "viewer-address" };
      const hops = c.req.header("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
      const forwarded = hops[hops.length - config.trustedProxyHops];
      if (forwarded) return { ip: forwarded, source: "x-forwarded-for" };
    }
    try {
      return { ip: getConnInfo(c).remote.address ?? "unknown", source: "connection" };
    } catch {
      return { ip: "unknown", source: "none" }; // not running on the Node server (tests, Lambda)
    }
  };

  /**
   * Bearer auth with constant-time comparison. Sets the rate-limit key to token + client IP:
   * every extension install shares one token, so the token alone would be one global bucket.
   */
  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const { ip, source } = clientIp(c);
    c.set("ipSource", source);
    if (tokenDigests.length === 0) {
      c.set("clientKey", `ip:${ip}`);
      return next();
    }
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
    const digest = token ? sha256(token) : undefined;
    if (!digest || !tokenDigests.some((d) => timingSafeEqual(d, digest))) {
      throw new HttpError(401, "unauthorized", "A valid API token is required.");
    }
    c.set("clientKey", `token:${digest.toString("hex").slice(0, 16)}|ip:${ip}`);
    return next();
  };

  const rateLimit: MiddlewareHandler<Env> = async (c, next) => {
    const decision = limiter.take(c.get("clientKey"));
    if (!decision.allowed) {
      const { retryAfterSeconds } = decision;
      throw new HttpError(429, "rate_limited", `Too many requests. Retry after ${retryAfterSeconds} seconds.`, retryAfterSeconds);
    }
    return next();
  };

  const transcriptNotFound = () => new HttpError(404, "transcript_not_found", "This video has no usable transcript.");
  const transcriptUnavailable = (cause: unknown) =>
    new HttpError(502, "transcript_unavailable", "The transcript could not be loaded. Try again later.", undefined, { cause });

  /**
   * Get the transcript from the transcript function and turn it into the README `Transcript`.
   * Its failures are not the client's fault: no captions is 404, anything else 502. The language
   * is settled here once (request, then transcript function, then detection) and passed on.
   */
  async function loadTranscript(request: FactCheckRequest, signal: AbortSignal): Promise<LoadedTranscript> {
    let fetched: Awaited<ReturnType<GetTranscript>>;
    try {
      fetched = await transcripts.get(request.videoId, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof TranscriptNotFoundError) throw transcriptNotFound();
      throw transcriptUnavailable(error);
    }
    if (fetched?.videoId !== request.videoId) {
      throw transcriptUnavailable(new Error(`The transcript function returned video ${String(fetched?.videoId)}`));
    }
    let segments: TranscriptSegment[];
    try {
      segments = parseTranscript(fetched.segments);
    } catch (error) {
      throw transcriptUnavailable(error); // malformed segments
    }
    const language = request.language ?? fetched.language ?? detectLanguage(segments);
    const transcript = segmentsToTranscript(request.videoId, segments, language);
    if (transcript.sentences.length === 0) throw transcriptNotFound();
    return { transcript, language };
  }

  /** Run the check, caching complete runs only (no failed claims). */
  async function run(
    c: Context<Env>,
    request: FactCheckRequest,
    { transcript, language }: LoadedTranscript,
    signal: AbortSignal,
    onResult?: (r: FactCheckResult) => void,
  ) {
    const startedAt = Date.now();
    let failedClaims = 0;
    const results = await checker.factCheck(transcript, {
      video: request.video,
      language,
      signal,
      onResult: (result, detail) => {
        if (detail.error) failedClaims++;
        onResult?.(result);
      },
    });
    if (failedClaims === 0) cache.set(cacheKey(request), results);
    logger.info(
      { requestId: c.get("requestId"), videoId: request.videoId, sentences: transcript.sentences.length, results: results.length, failedClaims, ms: Date.now() - startedAt },
      "fact check done",
    );
    return results;
  }

  /**
   * Map an error to its HTTP error and log it once, with the original cause. Expected client
   * errors (an HttpError under 500 with no cause) are not logged: the request log has the status.
   */
  const describeFailure = (c: Context<Env>, error: unknown, how: { timedOut: boolean; clientGone: boolean }) => {
    const httpError = toHttpError(error, how);
    const original = error instanceof HttpError ? error.cause : error;
    if (original === undefined && httpError.status < 500) return httpError;
    const level = httpError.status >= 500 ? "error" : "warn";
    logger[level]({ requestId: c.get("requestId"), code: httpError.code, error: errorInfo(original ?? error) }, "request failed");
    return httpError;
  };

  /** Behind CloudFront: reject anything that skipped it and hit the Lambda Function URL directly. */
  const originCheck: MiddlewareHandler<Env> = async (c, next) => {
    const secret = config.originSecret;
    if (secret && !sameSecret(c.req.header("x-origin-verify") ?? "", secret)) {
      throw new HttpError(403, "forbidden", "Forbidden.");
    }
    return next();
  };

  const anyOrigin = config.allowedOrigins.includes("*");
  app.use("*", requestId());
  app.use("*", originCheck);
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: anyOrigin ? "*" : (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept"],
      exposeHeaders: [CACHE_HEADER, TRANSCRIPT_SOURCE_HEADER],
      maxAge: 600,
    }),
  );
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    await next();
    logger.info(
      { requestId: c.get("requestId"), method: c.req.method, path: c.req.path, status: c.res.status, ipSource: c.get("ipSource"), ms: Date.now() - startedAt },
      "request",
    );
  });

  app.get("/health", (c) => c.json(ok({ ok: true })));

  app.post(
    "/factcheck",
    auth,
    rateLimit,
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: () => {
        throw new HttpError(413, "payload_too_large", `The body must be at most ${config.maxBodyBytes} bytes.`);
      },
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => {
        throw new HttpError(400, "invalid_json", "The body is not valid JSON.");
      });
      let request: FactCheckRequest;
      try {
        request = parseRequest(body);
      } catch (error) {
        throw toHttpError(error, { timedOut: false, clientGone: false });
      }
      const { videoId } = request;
      const cached = cache.get(cacheKey(request));
      const streaming = c.req.header("accept")?.includes("text/event-stream") ?? false;
      c.header(TRANSCRIPT_SOURCE_HEADER, transcripts.source);
      c.header(CACHE_HEADER, cached ? "hit" : "miss");

      if (cached && !streaming) return c.json(ok(cached));
      const writer = (stream: SSEStreamingApi) => {
        let id = 0;
        let writes = Promise.resolve();
        return (event: string, data: unknown) => {
          writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data), id: String(id++) }));
          return writes;
        };
      };
      if (cached) {
        return streamSSE(c, async (stream) => {
          const send = writer(stream);
          for (const result of cached) void send("result", result);
          await send("done", { videoId, count: cached.length, cached: true });
        });
      }

      // Load the transcript before any response starts, so its errors keep their real HTTP status.
      const timeout = AbortSignal.timeout(config.requestTimeoutMs);
      const requestSignal = AbortSignal.any([c.req.raw.signal, timeout]);
      let loaded: LoadedTranscript;
      try {
        loaded = await loadTranscript(request, requestSignal);
      } catch (error) {
        throw describeFailure(c, error, { timedOut: timeout.aborted, clientGone: c.req.raw.signal.aborted });
      }

      if (!streaming) {
        try {
          return c.json(ok(await run(c, request, loaded, requestSignal)));
        } catch (error) {
          throw describeFailure(c, error, { timedOut: timeout.aborted, clientGone: c.req.raw.signal.aborted });
        }
      }

      return streamSSE(c, async (stream) => {
        const send = writer(stream);
        const closed = new AbortController();
        stream.onAbort(() => closed.abort());
        try {
          const results = await run(c, request, loaded, AbortSignal.any([closed.signal, timeout]), (result) => void send("result", result));
          await send("done", { videoId, count: results.length, cached: false });
        } catch (error) {
          const httpError = describeFailure(c, error, { timedOut: timeout.aborted, clientGone: closed.signal.aborted });
          if (closed.signal.aborted) return;
          await send("error", { code: httpError.code, message: httpError.message, requestId: c.get("requestId") });
        }
      });
    },
  );

  app.notFound((c) => errorResponse(c, new HttpError(404, "not_found", "Not found.")));
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    return errorResponse(c, describeFailure(c, error, { timedOut: false, clientGone: false }));
  });

  return app;
}
