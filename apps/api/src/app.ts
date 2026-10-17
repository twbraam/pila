import { createHash, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { parseTranscript } from "@pila/factcheck";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { createTtlCache } from "./cache.js";
import type { ApiConfig } from "./env.js";
import { type FactCheckFn, type FactCheckItem, parseFactCheckItems } from "./factcheck/index.js";
import { errorInfo, fail, HttpError, toHttpError } from "./http.js";
import { createRateLimiter } from "./rate-limit.js";
import { type GetTranscript, isYouTubeVideoId, TranscriptNotFoundError, type VideoTranscript } from "./transcripts/index.js";

export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface AppDeps {
  readonly config: ApiConfig;
  readonly logger: Logger;
  /** The transcript function and its name (sent as `x-pila-transcript-source`). */
  readonly transcripts: { readonly get: GetTranscript; readonly source: string };
  /** The fact-check function and its name (sent as `x-pila-factcheck-source`). */
  readonly factCheck: { readonly run: FactCheckFn; readonly source: string };
}

type Env = { Variables: RequestIdVariables & { clientKey: string; ipSource: string } };

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** Constant-time string comparison (via fixed-length digests). */
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/** A header, so the body stays exactly `FactCheckItem[]`. */
const CACHE_HEADER = "x-pila-cache";
/** Tell clients which functions answered (mock or real). */
const TRANSCRIPT_SOURCE_HEADER = "x-pila-transcript-source";
const FACTCHECK_SOURCE_HEADER = "x-pila-factcheck-source";

const invalidRequest = (message: string) => new HttpError(400, "invalid_request", message);

/** Validate the request body (`{ videoId }`) before any work starts. */
function parseVideoId(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidRequest("The body must be a JSON object");
  const { videoId } = body as Record<string, unknown>;
  if (videoId === undefined) throw invalidRequest("videoId is required");
  if (!isYouTubeVideoId(videoId)) throw invalidRequest("videoId must be an 11-character YouTube video ID");
  return videoId;
}

export function createApp({ config, logger, transcripts, factCheck }: AppDeps) {
  const app = new Hono<Env>();
  const cache = createTtlCache<FactCheckItem[]>({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });
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
  const factCheckFailed = (cause: unknown) =>
    new HttpError(502, "factcheck_failed", "The fact check failed. Try again later.", undefined, { cause });

  /**
   * Call the transcript function and check what it returned. Its failures are not the client's
   * fault: no captions is 404, anything else 502.
   */
  async function loadTranscript(videoId: string, signal: AbortSignal): Promise<VideoTranscript> {
    let fetched: VideoTranscript;
    try {
      fetched = await transcripts.get(videoId, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof TranscriptNotFoundError) throw transcriptNotFound();
      throw transcriptUnavailable(error);
    }
    if (fetched?.videoId !== videoId) {
      throw transcriptUnavailable(new Error(`The transcript function returned video ${String(fetched?.videoId)}`));
    }
    let segments: VideoTranscript["segments"];
    try {
      segments = parseTranscript(fetched.segments);
    } catch (error) {
      throw transcriptUnavailable(error); // malformed segments
    }
    if (!segments.some((s) => s.text.trim())) throw transcriptNotFound();
    return { ...fetched, segments };
  }

  /** Call the fact-check function and validate its items before they reach clients. */
  async function check(transcript: VideoTranscript, signal: AbortSignal): Promise<FactCheckItem[]> {
    let raw: unknown;
    try {
      raw = await factCheck.run(transcript, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw factCheckFailed(error);
    }
    try {
      return parseFactCheckItems(raw);
    } catch (error) {
      throw factCheckFailed(error);
    }
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
      exposeHeaders: [CACHE_HEADER, TRANSCRIPT_SOURCE_HEADER, FACTCHECK_SOURCE_HEADER],
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

  app.get("/health", (c) => c.json({ ok: true }));

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
      const videoId = parseVideoId(body);
      c.header(TRANSCRIPT_SOURCE_HEADER, transcripts.source);
      c.header(FACTCHECK_SOURCE_HEADER, factCheck.source);
      const cached = cache.get(videoId);
      c.header(CACHE_HEADER, cached ? "hit" : "miss");
      if (cached) return c.json(cached);

      const timeout = AbortSignal.timeout(config.requestTimeoutMs);
      const signal = AbortSignal.any([c.req.raw.signal, timeout]);
      const startedAt = Date.now();
      try {
        const transcript = await loadTranscript(videoId, signal);
        const items = await check(transcript, signal);
        cache.set(videoId, items);
        logger.info({ requestId: c.get("requestId"), videoId, segments: transcript.segments.length, items: items.length, ms: Date.now() - startedAt }, "fact check done");
        return c.json(items);
      } catch (error) {
        throw describeFailure(c, error, { timedOut: timeout.aborted, clientGone: c.req.raw.signal.aborted });
      }
    },
  );

  app.notFound((c) => errorResponse(c, new HttpError(404, "not_found", "Not found.")));
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    return errorResponse(c, describeFailure(c, error, { timedOut: false, clientGone: false }));
  });

  return app;
}
