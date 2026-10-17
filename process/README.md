# Process

Process runs in the same Node.js server as Extract, using the root package and TypeScript configuration. `POST /check` extracts captions, passes the in-memory `Transcript` to Process, and returns the Overlay array. This implementation comes from `screen-verify` and uses **Gemini with Google Search grounding**.

## Input and library API

Input is the validated shared contract in [`shared/transcript.ts`](../shared/transcript.ts), with `videoId` and `sentences: { id, text, start, end }[]`. Raw cue arrays and the branch's older `{ segments }` format must first be converted to this contract. The merged CLIs and server use the same input.

```typescript
import { processTranscript } from './process';
import { extractTranscript } from './extract';

const transcript = await extractTranscript('OwqIy8Ikv-c', { lang: 'en' });
const results = await processTranscript(transcript);
```

Set `GEMINI_API_KEY` in the server environment or root `.env`. Entry points load `.env` without overriding existing environment variables. Library callers load their own environment or supply `apiKey` through `ProcessOptions`.

`ProcessOptions` also accepts `screenModel`, `verifyModel`, `threshold`, `timeoutMs`, `signal`, and an injectable `fetch` for offline tests. The default screening cutoff is 2, exclusive. Lower diagnostic cutoffs can check more sentences, but the public output still excludes scores of 2 or less. The default processing timeout is 180 seconds; the HTTP endpoint shares its 180-second deadline across extraction and processing. Signals propagate to every provider call.

## Screen, ground, judge

1. `screen.ts` reads the entire transcript and scores every sentence from 0 to 5. Only ratings **strictly greater than 2** proceed by default. The model must return every sentence exactly once with a rating and screening rationale.
2. `check.ts` sends the full transcript as context to Gemini with `google_search`, asking for findings only on flagged sentences. `grounding.ts` attaches sources only to findings cited by the provider's grounding metadata. It handles UTF-8 byte offsets and response part indices.
3. A separate Gemini call judges those findings as `truth`, `not_truth`, or `unchecked`. Missing results, duplicate IDs, invalid verdicts, and malformed output are errors. A conclusion without a cited HTTP(S) source, or with `NO SOURCES FOUND` findings, becomes `unchecked`.
4. `processTranscript()` returns only `not_truth` results with a rating above 2 and at least one cited source. It looks up each original sentence by ID, preserving the exact original text and start time. It returns results in transcript order, with the verifier's reason in `explanation`.

The rating is the screener's original suspicion score, including fractional values. It is not rescaled, rounded into an integer, or replaced by an invented verdict score. A high screening score alone never produces an Overlay item. Skipped sentences are not verified true.

## Output contract

The source of truth is [`shared/overlay-results.ts`](../shared/overlay-results.ts), with a portable [JSON Schema](../shared/overlay-results.schema.json). A successful HTTP check returns this top-level array:

```json
[
  {
    "timestamp": 42.5,
    "sentence": "Sample excerpt from video speech or transcript",
    "score": 4.25,
    "explanation": "The cited evidence contradicts the claim.",
    "sources": ["https://factcheck.org/..."]
  }
]
```

Every result has exactly five fields:

- `timestamp`: original sentence `start`, in seconds.
- `sentence`: original sentence `text`.
- `score`: finite number on the original 0–5 screening scale, strictly greater than 2 and at most 5.
- `explanation`: nonempty evidence-based reason from the verifier.
- `sources`: at least one HTTP(S) URL cited for this sentence.

No reportable problems produces `[]`. Failures remain non-2xx errors; incomplete processing never becomes a partial successful response. The server validates the contract and original text/timestamp association before replying.

## CLI diagnostics

Run commands from the repository root:

```bash
npm run extract -- OwqIy8Ikv-c --out transcript.json
npm run screen -- transcript.json --all
npm run check -- transcript.json --format json
npm run check -- transcript.json --threshold 2 --out report.txt
npm run factcheck -- transcript.json --format json
```

`screen` scores sentences and lists those strictly above `--threshold` (default 2); `--all` includes every sentence. `check` runs screening, grounding, and judging; its default text report lists sourced problems, while `--format json` includes every verified sentence, model names, screening rationales, verdicts, counts, and timing. These diagnostic objects are separate from the HTTP Overlay contract.

`factcheck` retains the branch's separate whole-video workflow: overview, grounding of factual claims, judging, and a report of the video's message and problems. It does not use the screening cutoff and does not supply `/check`'s output. All three CLIs accept `--out`; `check` and `factcheck` accept `--format text|json`.

`SCREEN_MODEL` defaults to `gemini-3.5-flash-lite`; `FACTCHECK_MODEL` defaults to `gemini-3.8-flash`, retaining the branch settings. Models are resolved when called, after `.env` loading. Gemini 2.5 models use zero thinking budget; other selected models receive minimal thinking for screening and low thinking for verification. Your account must support the chosen models and grounding tool.

## Limits and verification

The entire transcript is included in each stage. Very long videos can exceed the provider's context or output limits and fail; there is no automatic truncation or retry. Missing captions fail extraction without audio transcription fallback. Grounded findings and verdicts remain model assessments, and source URLs may be Google redirect URLs.

`npm test` runs offline tests for extraction, model-response validation, threshold boundaries, grounded source attribution, original sentence mapping, the public contract, and local HTTP integration. Live YouTube/Gemini behavior and account quotas require separate verification with valid credentials.
