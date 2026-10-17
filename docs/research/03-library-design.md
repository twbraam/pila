# Library design

A proposal for review. Names and defaults are open to change.

## Runtime rules

The library must run unchanged in a Chrome MV3 service worker and in Node 22+.

- ESM only. Only web-standard APIs: `fetch`, `AbortController`, `Intl.Segmenter`,
  `URL`, `crypto.randomUUID`.
- No Node built-ins (`fs`, `path`, `process.env`), no `window`, no DOM.
- Keys are passed in. The library never reads env vars or `chrome.storage`.
- Dependencies: `@typesafe-ai/sdk` (zero deps) and `zod` (input validation). Tavily via `fetch`.
- `fetch` is injectable, for tests and for the extension to add logging.
- Never log keys, and never put them in error messages.

## Public API

```ts
import { createFactChecker } from "@pila/factcheck";

const checker = createFactChecker({
  typesafeApiKey: "...",
  tavilyApiKey: "tvly-...",
  model: "jev-1.13.0",          // default
  // optional: fetch, domains, thresholds, maxClaims, concurrency
});

const report = await checker.checkVideo(
  {
    video: { id: "abc123", title: "...", channel: "PragerU", url: "https://www.youtube.com/watch?v=abc123" },
    transcript,                 // TranscriptSegment[]
    language: "en",             // "en" | "zh"; detected if omitted
  },
  { signal, onProgress },       // cancel; progress events for the UI
);
```

Building blocks are exported too, so the extension team (or the eval scripts) can run
one step at a time:

```ts
toSentences(transcript, language): Sentence[]                  // pure, no network
checker.findClaims(sentences, opts?): Promise<Claim[]>         // Jev x1
checker.searchEvidence(claim, video?): Promise<Evidence[]>     // Tavily x1
checker.verifyClaim(claim, evidence): Promise<ClaimResult>     // Jev x1
```

## Types

```ts
type TranscriptSegment = { text: string; start: number; duration: number };
type Sentence = { index: number; start: number; text: string };
type Claim = Sentence & { checkable: number };                 // Jev noul
type Evidence = { source: string; url: string; text: string; trusted: boolean; score: number };
type Stance = "refutes" | "supports" | "not_relevant";
type Label = "true" | "false" | "misleading" | "insufficient_evidence" | "not_sure";

type ClaimResult = {
  claim: Claim;
  label: Label;
  confidence: number;
  sources: Array<Evidence & { stance: Stance; stanceConfidence: number }>;
  jev: { model: string; verdict: string; verdictReversed: string }; // raw, for debugging
};

type VideoReport = {
  video: VideoInfo;
  language: "en" | "zh";
  claims: ClaimResult[];
  videoReviews: Evidence[];        // results from the video-level search
  usage: { jevInputTokens: number; tavilyCredits: number; durationMs: number };
};
```

`TranscriptSegment` matches the format of `ref/transcript.json` and of the popular
`youtube-transcript-api` Python package. That gives the extension team a clear target.

## Pipeline details

1. **`toSentences`**
   - Split each segment's `text` by `\n`. A line with CJK characters is Chinese; others
     are English. Single-language transcripts work too.
   - Join lines until one ends with sentence punctuation (`. ? ! :` or `。？！：`).
     Keep the first segment's `start`. Gives 40 sentences from the 67 segments in
     `ref/transcript.json`.
   - For text without punctuation (auto-generated captions), fall back to
     `Intl.Segmenter(lang, { granularity: "sentence" })`, then a max length.
2. **`findClaims`**: one Jev request, a `noul` per sentence. Keep `noul >= 0.7`, top K
   by score (K default 5).
3. **`searchEvidence`**: one video-level search (once per video) + one per claim, in
   parallel with a concurrency limit (default 4). Filter, de-duplicate, cap, mark trusted.
4. **`verifyClaim`**: one Jev request per claim, in parallel. Evidence = the claim's
   results + relevant video-level reviews (at most 5 sources).
5. **Combine** with the rules in [01](./01-jev-integration.md#combining-the-answers-in-code).

## Errors

Typed errors so the UI can show a clear message:

| Error | When | UI message idea |
| - | - | - |
| `InvalidInputError` | Bad transcript or empty video | "This video has no usable transcript" |
| `AuthError` (`service: "jev" \| "tavily"`) | 401 | "Check your Jev / Tavily API key" |
| `RateLimitError` | 429 after retries | "Too many requests, try again in a minute" |
| `QuotaError` | Tavily 432/433 | "Tavily credits used up" |
| `UpstreamError` | 5xx, 529, timeouts | "Service unavailable, try again" |

If one claim fails, the report still returns the other claims, and the failed one gets
an `error` field. The whole call fails only on bad input or bad keys.

## Repo layout (proposal)

```
packages/factcheck/           # @pila/factcheck, this team
  src/
    index.ts                  # public exports
    transcript.ts             # toSentences
    jev/detect.ts             # claim-detection request + parsing
    jev/verify.ts             # verification request + parsing
    tavily.ts                 # fetch client + result mapping
    verdict.ts                # combine rules
    errors.ts
    config.ts                 # defaults: model, thresholds, domain list
  test/
  scripts/check-video.ts      # CLI: node scripts/check-video.ts ref/transcript.json
apps/extension/               # extension team (WXT), imports @pila/factcheck
```

npm workspaces, so the extension imports the library from source with no publishing.
Build with `tsup` (ESM + `.d.ts`). The CLI script is the quickest demo and smoke test.
