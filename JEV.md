# Jev transcript screening

## Goal and flow

Find YouTube statements worth fact-checking and return their timestamps. Creator-provided subtitles are assumed to capture speech accurately—not to prove the speaker's claims true. This stage uses Jev's background knowledge without searching for evidence.

```text
Extract's transcript JSON → shared context windows → Jev rates each target
                         → ranked sentences with original timestamps
```

**A high score means “review this first,” not “proven false.”**

## Files

- `process/preprocess.ts`: validates Extract's JSON, detects Chinese/English, prepares oversized Mandarin text, loads the matching prompt, and builds batches. No API calls.
- `process/jev_call.ts`: uses preprocessing, calls Jev, records timing, and saves ranked results.
- `prompts/jev.en.json` and `prompts/jev.zh-TW.json`: editable English and Traditional Chinese prompts.
- `examples/transcripts/`: ready-to-use input files from `main`. No job configs or Python scripts.

## Run

Requires **Node.js 22+**. Install dependencies:

```bash
npm ci
```

Use a transcript directly:

```bash
# Prepare calls only; no API calls
npm run preprocess -- examples/transcripts/OwqIy8Ikv-c.json

# Call Jev and save scores
npm run jev -- examples/transcripts/zmfRG8-RHEI.json
```

Optional settings:

```bash
npm run jev -- examples/transcripts/OwqIy8Ikv-c.json \
  --batch-size 64 --context-tokens 4000 \
  --decision-type score --threshold 2 --language auto
```

| Option | Default | Meaning |
|---|---|---|
| `--batch-size` | `64` | Maximum target sentences per call |
| `--context-tokens` | `4000` | Estimated token budget for shared context |
| `--decision-type` | `score` | `score` or `noul` |
| `--threshold` | `2` for score, `0.7` for noul | Starting review cutoff |
| `--language` | `auto` | Detect the prompt language, or override with `en` / `zh-TW` |
| `--outdir` | Automatic run folder | Optional new output directory; must not already exist |

Credentials come from the environment or root `.env`: `TYPESAFE_API_KEY`, `JEV_API`, `JEV_API_KEY`, or `TYPE_SAFE_API_KEY`. Environment values take precedence. Keep keys private; do not bundle a shared key into an extension.

## Input and batching

Use the shared contract in `shared/transcript.ts`:

```json
{
  "videoId": "OwqIy8Ikv-c",
  "sentences": [
    {"id": "s0001", "text": "A spoken statement.", "start": 2.42, "end": 8.56}
  ]
}
```

Extract already assembles sentences. Processing preserves original IDs and time bounds. Raw caption arrays must first be normalized by Extract.

### Language and Mandarin preprocessing

The transcript does not need a language field. Processing counts Han characters and Latin letters: a Han share of at least 20% selects `zh-TW`; otherwise it selects `en`. The choice and counts are recorded in the manifest, and each Jev call includes `state.language`. Use `--language en` or `--language zh-TW` to override it.

This is a routing heuristic for Chinese/English text, not a general spoken-language detector. `zh-TW` selects Traditional Chinese instructions; it does not translate text, distinguish Mandarin from Taiwanese, or convert Simplified Chinese.

Some Chinese transcript entries contain long paragraphs. Oversized entries are split into smaller, token-bounded parts, preferring nearby punctuation or spaces. Every character is retained. Parts have unique target IDs such as `s0003::part-1`, while `sourceSentenceId` records the original ID. Parts keep the **whole source sentence's** start/end times—no finer timestamps are invented.

Many target sentences share one context window. Each target gets an independent question in the **same API request**, so several sentences—or none—can score highly.

The context contains sentence IDs and text only. Batch construction reserves nearby sentences, reduces the target count if needed, and expands the window with remaining space. Whole sentences stay in order. Each sentence is a target once; context may overlap across requests.

The 4,000-token estimate uses `cl100k_base`, not a verified Jev tokenizer. It covers the context array; target text and instructions add more tokens to the full request. Oversized targets fail rather than being silently cut.

## Prompt structure

Each language's JSON contains:

| Field | Purpose |
|---|---|
| `shared_instructions` | YouTube screening rules, supplied once in `state.screeningPolicy` |
| `target_instructions` | Short question identifying `{target_id}` |
| `decision_types.score` | Concern-strength rubric |
| `decision_types.noul` | Yes/no factual-concern criteria |

The prompts require a specific issue in the target itself. They distinguish endorsement from neutral quotation or rebuttal. Opinions, disagreement, missing citations, and dramatic wording alone are not factual errors. A correct sentence must not inherit suspicion from the video's overall argument.

## How scores work

Score mode rates each target against four ordered levels:

| Level | Meaning | Review action |
|---|---|---|
| **0** | No specific endorsed factual problem identified; includes ordinary facts, opinions, neutral quotations, and rebuttals. | Lower priority. |
| **1** | Weak or unclear concern; wording, scope, or endorsement is uncertain. | Inspect context. |
| **2** | A specific claim has a plausible factual contradiction or materially misleading inference. | Queue for checking. |
| **3** | A claim appears directly inconsistent with established knowledge, or its stated inference is clearly invalid. | Higher priority. |

Jev returns an **expected score**, so fractional values are normal. Equal weight on levels 2 and 3 gives `2.5`. A result such as `2.48` is not a percentage or a probability of falsehood.

Results are ranked highest first. The starting threshold of `2.0` filters a review list, but the complete ranking remains available because useful candidates can fall below it.

For comparison, `noul` returns a 0–1 model probability for the defined event: a specific endorsed factual concern worth checking. It is not a calibrated probability that the real-world claim is false. Select it with `--decision-type noul`; its default threshold is `0.7`.

Jev's `choice` type allows multiple answer options, but this workflow uses numeric ratings for ranking. A limit on answer choices is not the same as a limit on questions per request. Earlier live calls successfully included 64 targets.

## Calling from a server API

`npm run jev` is only the CLI entry point. Importing `process/jev_call.ts` does **not** run the CLI or make network calls. Your handler can call the existing exported function directly:

```typescript
import { run } from '../process/jev_call';

const runDirectory = await run({
  transcript: savedTranscriptPath, // Server-owned path returned by Extract.
  language: 'auto',
  batchSize: 64,
  contextTokens: 4000,
  decisionType: 'score',
  threshold: 2,
  outdir: undefined,
});
```

`run()` prepares requests, loads credentials, calls Jev, saves artifacts, and returns the run directory. It does not return the scored JSON directly; that is saved as `results.json` in that directory. Do not spawn `npm` from the endpoint or accept arbitrary client-provided filesystem paths.

For lower-level control, `callJev(apiKey, payload)` returns the raw response without writing files, and `summarize(payload, response, threshold)` maps it to timestamped screening results. An in-memory high-level wrapper can be added later if the API should avoid transcript/result files.

These internal results are separate from main's planned Overlay response `{timestamp, sentence, score, sources}`. That final `score` must be an integer; the current fractional screening score must not be silently treated as the final judgment.

## Results folder

```text
results/<videoId>/<timestamp>/
  calls/0000.json       Outgoing request; further batches use 0001, 0002, ...
  responses/0000.json   Raw Jev response, live runs only
  results.json          Ranked results, live runs only
  manifest.json         Input hash, settings, progress, timing, and token usage
```

`npm run jev` always calls the API and saves calls, responses, and results. The separate `npm run preprocess` command only prepares calls and a manifest. `results/` is included in Git so the team can inspect actual calls and replies. `.env` stays ignored. A failed live run retains partial files; rerunning starts a new run, not an automatic resume.

`results.json` contains:

- **`targets`**: every result in transcript order.
- **`rankedSegments`**: every result, highest concern first.
- **`suspectedSegments`**: results at or above the chosen threshold.

Each result preserves `videoId`, original `sentenceId`, text, `start`, and `end`, plus its score and `truthStatus: not_assessed`. New results also include the selected language, unique `targetId`, part number/count, and `timestampPrecision: source_sentence`. Split parts share their parent's original time range. Lower scores are not verified true; higher scores need review before a factual misinformation warning.

## Latest live run

Results now cover all **13 transcripts** in `examples/transcripts/`, using score mode and threshold 2. The ten earlier English runs are retained; the three new Chinese videos were live-tested with automatic `zh-TW` selection:

- **2,248 source sentences** → **2,267 targets** after splitting long Chinese entries.
- **45 API calls**, **179 review candidates**, and **15.66 seconds** total API round-trip time, excluding preprocessing and file handling.
- `zmfRG8-RHEI`: 789 sentences, 13 calls, 78 candidates, 4.78 seconds API time.
- `UM82qxxskZE`: 1,101 sentences, 18 calls, 57 candidates, 6.15 seconds API time.

The three Chinese videos used six new calls: `7wFWgopJP5Q` produced 24 targets from 17 entries, `BSI8oxcQFfw` produced 16 from 9, and `TGUeqcBXy_A` produced 19 from 14.

`results/summary.json` lists every video's language, counts, timing, and result-file path. All source sentences, reconstructed text, original timestamps, calls, and responses were checked for complete coverage. Preparation-only folders were removed; `npm run jev` now always makes live calls. `npm run typecheck` passes. These are measured screening results, not verified falsehood counts or guaranteed latency.
