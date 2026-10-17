# @pila/api

The hosted API for the Pila extension. It runs [`@pila/factcheck`](../../packages/factcheck) on the
server, so the Jev and Tavily keys never ship in the extension.

Live: **`https://d3tuhog92nak7r.cloudfront.net`** (CloudFront → Lambda). See
[`infra/aws/README.md`](../../infra/aws/README.md) for the stack and
[`packages/factcheck/docs/workflow.md`](../../packages/factcheck/docs/workflow.md) for the full flow.

## Endpoints

```text
GET  /health                         -> 200 { success: true, data: { ok: true }, error: null }
POST /factcheck                      -> 200 { success: true, data: FactCheckResult[], error: null }
     Authorization: Bearer <token>      headers x-pila-cache: hit | miss
     { videoId, video?: { title, channel }, language?: "en" | "zh" }      x-pila-transcript-source: mock | ...
```

`videoId` is the 11-character YouTube ID (`OwqIy8Ikv-c`). The API loads the transcript itself (see below).
`FactCheckResult` is the shared contract in the [repo README](../../README.md).
Always send `video.title` and `video.channel`: they find published reviews of the video, the best
evidence. Errors use `{ success: false, data: null, error: { code, message, requestId } }`.

From the extension's service worker:

```ts
const res = await fetch("https://d3tuhog92nak7r.cloudfront.net/factcheck", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ videoId, video: { title, channel } }),
  signal: AbortSignal.timeout(60_000),
});
const { success, data, error } = await res.json(); // data: FactCheckResult[]
```

Add `"https://d3tuhog92nak7r.cloudfront.net/*"` to the extension's `host_permissions`. Render
`explanation` and source titles as plain text; they come from the web.

## Transcripts

`POST /factcheck` calls a transcript function with the video ID. The contract
(`src/transcripts/provider.ts`):

```ts
type GetTranscript = (videoId: string, options?: { signal?: AbortSignal }) => Promise<{
  videoId: string;
  segments: { text: string; start: number; duration: number }[]; // same shape as ref/transcript.json
  language?: "en" | "zh"; // optional; detected from the text otherwise
}>;
// Throw TranscriptNotFoundError when the video has no usable captions (API answers 404).
// Any other error becomes 502 transcript_unavailable. Respect `signal` (55 s budget, client gone).
```

Today only the mock is registered (`src/transcripts/mock.ts`): it returns the sample transcript
(`src/transcripts/mock-transcript.json`, a copy of `ref/transcript.json`, kept identical by a test) for
**every** video. To plug in the real function:

1. Add it under `src/transcripts/` and register it in `transcriptProviders` (`src/transcripts/index.ts`),
   for example `youtube: getYouTubeTranscript`.
2. Set `TRANSCRIPT_SOURCE=youtube` (Lambda: `aws lambda update-function-configuration ... --environment
   "Variables={TRANSCRIPT_SOURCE=youtube}"`; this replaces all env vars, and there are none today).
3. Rebuild and deploy (`npm run build:lambda -w @pila/api`, then `update-function-code`).

| Transcript function result | API response |
| - | - |
| segments | runs the fact check, `200` |
| `TranscriptNotFoundError`, or segments with no text | `404 transcript_not_found` |
| malformed segments, any other error | `502 transcript_unavailable` (details only in logs) |

## Configuration (env)

| Variable | Default | Notes |
| - | - | - |
| `TYPESAFE_API_KEY` | required | Jev key |
| `TAVILY_API_KEY` | keyless mode | Tavily key |
| `PILA_API_TOKENS` | none | comma-separated client tokens; required when `NODE_ENV=production` |
| `ORIGIN_VERIFY_SECRET` | none | when set, every request needs it in `x-origin-verify` |
| `ALLOWED_ORIGINS` | none | CORS allow-list, or `*` |
| `RATE_LIMIT_PER_MINUTE` | 20 | per token + client IP (all installs share one token) |
| `CACHE_TTL_SECONDS` / `CACHE_MAX_ENTRIES` | 21600 / 500 | in-memory cache of complete runs |
| `REQUEST_TIMEOUT_SECONDS` | 55 | under CloudFront's and Lambda's 60 s |
| `MAX_BODY_BYTES` | 16384 | the body is only an ID and title/channel |
| `TRANSCRIPT_SOURCE` | mock | which transcript function to call; see Transcripts |
| `TRUST_PROXY` | false | read the client IP from `CloudFront-Viewer-Address`, else `X-Forwarded-For` |
| `TRUSTED_PROXY_HOPS` | 1 | trusted proxies appending to `X-Forwarded-For`; earlier (client-supplied) entries are ignored |
| `PORT` / `HOST` / `LOG_LEVEL` | 8787 / 0.0.0.0 / info | Node server only |

On Lambda, the four secrets come from SSM (`/pila/factcheck/*`) instead, and `ALLOWED_ORIGINS=*`,
`TRUST_PROXY=true` are the defaults.

## Run and test

```bash
npm run dev -w @pila/api            # local server on :8787, reads the repo .env, uses the library source
npm test -w @pila/api               # unit tests (no network)
npm run test:coverage -w @pila/api
npm run typecheck -w @pila/api
npm run build:lambda -w @pila/api   # Lambda bundle: apps/api/dist-lambda/function.zip
docker build -t pila-api .          # from the repo root; any container host
```

Locally, `Accept: text/event-stream` streams one `result` event per sentence, then `done`. On
Lambda the Function URL buffers responses, so use plain JSON there.
