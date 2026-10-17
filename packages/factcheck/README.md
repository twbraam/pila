# @pila/factcheck

The Processing module from the [repo README](../../README.md). It fact-checks a YouTube video
from its transcript: it finds checkable claims with TypeSafe's Jev model, searches for evidence
with Tavily, and asks Jev whether the evidence supports or refutes each claim.

Runs in a Chrome MV3 service worker and in Node 22+. ESM only, web-standard APIs only.

## Use it

```ts
import { createFactChecker } from "@pila/factcheck";

const checker = createFactChecker({
  typesafeApiKey,             // required
  tavilyApiKey,               // optional: without it, Tavily's rate-limited keyless mode is used
});

// transcript: the README `Transcript` from Ingestion: { videoId, sentences: [{ id, text, startSeconds, endSeconds }] }
const results = await checker.factCheck(transcript, {
  video: { title: "Climate Change: What Do Scientists Say?", channel: "PragerU" },
  onResult: (result) => overlay.add(result),   // streams each FactCheckResult as it completes
  signal,                                      // cancel when the user leaves the video
});
```

`results` is `FactCheckResult[]` in video order; see the repo README for the type. Overlay shows
a warning only for `verdict: "misinformation"`, and must render `explanation` and source titles as
plain text (they come from the web). If `onResult` throws, the run continues and the error is
passed to `reportError`.

Without Ingestion (tests, demos), build a `Transcript` from raw caption segments with
`segmentsToTranscript(videoId, segments)`.

### Detailed report

`checkVideo` runs the same pipeline on raw caption segments and returns every label, source,
and stance, plus usage. Use it for debugging and evals:

```ts
const report = await checker.checkVideo(
  {
    video: { id: "abc123", title: "Climate Change: What Do Scientists Say?", channel: "PragerU" },
    transcript,               // [{ text, start, duration }, ...]
    language: "en",           // "en" | "zh"; detected when omitted (English first)
  },
  { signal, onProgress: (e) => console.log(e.stage, e.done, e.total) },
);

for (const c of report.claims) {
  console.log(c.claim.start, c.label, c.confidence, c.claim.text);
  for (const s of c.sources) console.log("  ", s.stance, s.source, s.url);
}
```

Always pass `title` and `channel`. They are how the library finds published reviews of the
video, which are by far the best evidence.

### In the extension

The extension does **not** import this library: it calls the hosted API ([`apps/api`](../../apps/api)), which runs
it on the server with the keys. Use the library directly only for scripts, tests, and servers. It also runs in an
MV3 service worker (tested), which is how it would work if a key ever had to live in the extension.

## Labels (detailed report)

`factCheck` maps these to `verdict`: `false` -> `misinformation`, `true` -> `verified`,
everything else -> `unknown`. Set `misleadingAs: "misinformation"` in the config to also warn
on `misleading`.

| `label` | Meaning |
| - | - |
| `false` | Evidence (usually a trusted fact-checker) says the claim is false |
| `misleading` | Some truth, but distorted or missing context |
| `true` | Evidence confirms the claim |
| `insufficient_evidence` | Nothing relevant was found |
| `not_sure` | Jev was unsure or inconsistent, trusted sources conflict, or this claim failed (`error` is set) |

Each claim also has `confidence` (0-1), its `start` time in seconds, and `sources`, each with
`stance` (`refutes` / `supports` / `not_relevant`) and `url`. If the video-level search failed,
`report.videoSearchError` says why (claims are still checked).

## Errors

All errors extend `FactCheckError` and have `service` (`"jev"` / `"tavily"`) and `status`
when they come from an API. Messages never contain API keys.

| Error | When | The run... |
| - | - | - |
| `InvalidInputError` | Bad transcript, video info, or config | fails |
| `AuthError` | Missing or rejected key | fails |
| `CancelledError` | `signal` aborted | fails |
| `RateLimitError` | 429 after retries | fails that claim only |
| `QuotaError` | Tavily credits used up | fails |
| `UpstreamError` | 5xx, timeouts, unexpected responses | fails that claim only |

## Options

`createFactChecker` also takes `model` (default `jev-1.13.0`, pinned), `misleadingAs`, `fetch`, `maxRetries`,
`trustedDomains`, `thresholds`, and `limits`. Defaults are exported as `DEFAULT_MODEL`,
`DEFAULT_THRESHOLDS`, `DEFAULT_LIMITS`, and `DEFAULT_TRUSTED_DOMAINS`. The default is 5 claims
per video.

The steps are exported too, for experiments: `toSentences`, `checker.findClaims`,
`checker.searchEvidence`, `checker.verifyClaim`, `buildDetectionRequest`, `buildVerificationRequest`.

## Cost per video (5 claims)

1 Jev detection request + 5 Jev verification requests (well under $0.01), and 6 Tavily
advanced searches = 12 credits (the free plan has 1,000 per month).

## Develop

```bash
npm test -w @pila/factcheck                 # unit tests (no network)
npm run test:coverage -w @pila/factcheck    # with 80% thresholds
npm run typecheck -w @pila/factcheck
npm run build -w @pila/factcheck            # tsc -> dist/
npm run test:sw -w @pila/factcheck          # runs the library in a real MV3 service worker (Playwright)
npm run test:contract -w @pila/factcheck    # real APIs; keys from the repo's .env
npm run check-video -w @pila/factcheck -- ../../ref/transcript.json --id OwqIy8Ikv-c --channel PragerU --title "Climate Change: What Do Scientists Say?"
```

`check-video` prints the `FactCheckResult[]` (add `--json` for raw JSON, `--report` for the detailed report).

`test:sw` needs Playwright's Chromium once: `npx playwright install chromium`. Its Jev and
Tavily checks make real network calls (a bad-key Jev call and a keyless Tavily search).
