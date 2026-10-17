# @pila/api

The hosted API for the Pila extension. Given a YouTube video ID, it chains two functions, both owned by
teammates: **transcript** (video ID → caption segments) and **fact check** (segments → `FactCheckItem[]`).
Until they ship, both are mocks.

Live: **`https://d3tuhog92nak7r.cloudfront.net`** (CloudFront → Lambda). See
[`infra/aws/README.md`](../../infra/aws/README.md) for the stack.

## Endpoints

```text
GET  /health                         -> 200 { ok: true }
POST /factcheck                      -> 200 FactCheckItem[]
     Authorization: Bearer <token>      headers x-pila-cache: hit | miss
     { "videoId": "OwqIy8Ikv-c" }               x-pila-transcript-source: mock | ...
                                                x-pila-factcheck-source: mock | ...
```

```ts
type FactCheckItem = { timestamp: number; sentence: string; score: 0 | 1 | 2 | 3; sources: string[] };
```

`videoId` is the 11-character YouTube ID. The body is the bare array, no envelope. Errors are
`{ error: { code, message, requestId } }` with a 4xx/5xx status.

```bash
curl -s -X POST https://d3tuhog92nak7r.cloudfront.net/factcheck \
  -H "authorization: Bearer $PILA_API_TOKEN" -H 'content-type: application/json' \
  -d '{"videoId":"OwqIy8Ikv-c"}'
```

From the extension's service worker:

```ts
const res = await fetch("https://d3tuhog92nak7r.cloudfront.net/factcheck", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ videoId }),
  signal: AbortSignal.timeout(60_000),
});
if (!res.ok) throw new Error((await res.json()).error.message);
const items: FactCheckItem[] = await res.json();
```

Add `"https://d3tuhog92nak7r.cloudfront.net/*"` to the extension's `host_permissions`. Render
`sentence` and `sources` as plain text.

## Flow

```text
POST { videoId } -> origin check -> token -> rate limit -> validate -> cache (6 h, by videoId)
  -> getTranscript(videoId, { signal })          src/transcripts/
  -> factCheck({ videoId, segments }, { signal }) src/factcheck/
  -> validate items -> cache -> 200 FactCheckItem[]
```

`signal` aborts at 55 s or when the client leaves.

## Transcript function

Contract: `src/transcripts/provider.ts`.

```ts
type GetTranscript = (videoId: string, options?: { signal?: AbortSignal }) => Promise<{
  videoId: string;
  segments: { text: string; start: number; duration: number }[]; // same shape as ref/transcript.json
  language?: "en" | "zh";
}>;
// Throw TranscriptNotFoundError when the video has no usable captions (API answers 404).
```

The mock (`src/transcripts/mock.ts`) returns `src/transcripts/mock-transcript.json` (a copy of
`ref/transcript.json`, kept identical by a test) for **every** video.

| Transcript function result | API response |
| - | - |
| segments | goes on to the fact check |
| `TranscriptNotFoundError`, or no text | `404 transcript_not_found` |
| malformed segments, another video's ID, any other error | `502 transcript_unavailable` (details only in logs) |

## Fact-check function

Contract: `src/factcheck/provider.ts`.

```ts
type FactCheckFn = (
  transcript: { videoId: string; segments: { text: string; start: number; duration: number }[]; language?: "en" | "zh" },
  options?: { signal?: AbortSignal },
) => Promise<FactCheckItem[]>;
```

The API validates what it returns: `timestamp` ≥ 0, `score` an integer 0-3, `sources` http(s) URLs (at most 20),
and drops any extra fields. A throw or an invalid item gives `502 factcheck_failed` (details only in logs).

The mock (`src/factcheck/mock.ts`) returns five fixed items for the Lindzen video, for **every** video. Sentences
and sources come from earlier live runs of `@pila/factcheck`; the scores are made up.

## Plugging in the real functions

1. Add the function under `src/transcripts/` or `src/factcheck/` and register it in `transcriptProviders`
   (`src/transcripts/index.ts`) or `factCheckProviders` (`src/factcheck/index.ts`), for example `team: teamFactCheck`.
2. Set `TRANSCRIPT_SOURCE` / `FACTCHECK_SOURCE` to that name. Lambda: `aws lambda update-function-configuration
   --region us-west-2 --function-name pila-factcheck --environment "Variables={FACTCHECK_SOURCE=team}"` (this
   replaces all env vars; there are none today).
3. If it needs a secret, add an SSM parameter under `/pila/factcheck/` and read it in `loadSsmSecrets` (`src/lambda.ts`).
4. Rebuild and deploy (`npm run build:lambda -w @pila/api`, then `update-function-code`).

## Configuration (env)

| Variable | Default | Notes |
| - | - | - |
| `PILA_API_TOKENS` | none | comma-separated client tokens; required when `NODE_ENV=production` |
| `ORIGIN_VERIFY_SECRET` | none | when set, every request needs it in `x-origin-verify` |
| `ALLOWED_ORIGINS` | none | CORS allow-list, or `*` |
| `RATE_LIMIT_PER_MINUTE` | 20 | per token + client IP (all installs share one token) |
| `CACHE_TTL_SECONDS` / `CACHE_MAX_ENTRIES` | 21600 / 500 | in-memory cache, keyed by video ID |
| `REQUEST_TIMEOUT_SECONDS` | 55 | under CloudFront's and Lambda's 60 s |
| `MAX_BODY_BYTES` | 16384 | the body is only a video ID |
| `TRANSCRIPT_SOURCE` | mock | which transcript function to call |
| `FACTCHECK_SOURCE` | mock | which fact-check function to call |
| `TRUST_PROXY` | false | read the client IP from `CloudFront-Viewer-Address`, else `X-Forwarded-For` |
| `TRUSTED_PROXY_HOPS` | 1 | trusted proxies appending to `X-Forwarded-For`; earlier (client-supplied) entries are ignored |
| `PORT` / `HOST` / `LOG_LEVEL` | 8787 / 0.0.0.0 / info | Node server only |

On Lambda, the origin secret and API tokens come from SSM (`/pila/factcheck/*`) instead, and `ALLOWED_ORIGINS=*`,
`TRUST_PROXY=true` are the defaults.

## Run and test

```bash
npm run dev -w @pila/api            # local server on :8787, reads the repo .env
npm test -w @pila/api               # unit tests (no network)
npm run test:coverage -w @pila/api
npm run typecheck -w @pila/api
npm run build:lambda -w @pila/api   # Lambda bundle: apps/api/dist-lambda/function.zip
docker build -t pila-api .          # from the repo root; any container host
```
