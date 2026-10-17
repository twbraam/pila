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
- `process/tavily.ts`: optional application API for grouped evidence searches and source-based Jev assessment. It is not another CLI.
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

## Second stage: Tavily evidence API

Screening is not proof. Only **score values strictly greater than 2** enter the evidence queue. `npm run jev` still performs screening only; Tavily is called explicitly by application code:

```typescript
import { verifySuspicions } from './process/tavily';

const evidence = await verifySuspicions(transcript, screeningResults.targets, {
  maxSearches: 3,
});
```

`transcript` is the validated Extract output. Candidates must match its original IDs, text, and timestamps. The function reads `TAVILY_API_KEY` and the Jev key from the server environment or root `.env`; it calls Tavily's REST API directly, not assistant tools.

### How we avoid searching every sentence

1. Prioritize high scores and take at most 40 candidates per pass.
2. Form small research bundles using shared subject words, up to six targets per bundle. This is approximate topic grouping, **not** a claim that all statements mean the same thing.
3. Make one neutral Tavily query per selected bundle, with a hard default cap of three searches/bundles. Unprocessed targets remain explicitly `pending`, not cleared as true.
4. Reuse exact query/settings matches from a seven-day cache. Cached hits do not call Tavily again. Requests use `basic` depth with automatic parameter selection disabled; no hidden advanced-search escalation.
5. Retrieve up to four sources per search. Pass their excerpts to Jev once per bundle where possible, with separate claim/source questions. Large assessment requests split within a token budget.

`planEvidenceChecks(transcript, targets)` returns the proposed bundles/queries without network calls. Policy settings and reviewed source domains are in `prompts/evidence-policy.json`; evidence-assessment instructions remain JSON in `prompts/evidence.en.json` and `evidence.zh-TW.json`.

### When can a source contradict a claim?

Search rank or a familiar domain is not proof. The source registry is a retrieval preference; Jev must separately judge whether each actual excerpt provides direct evidence, a secondary summary, or unusable material. It then compares that excerpt against **each target separately**, checking attribution, date, scope, and qualifiers. Unknown claim dates are not assumed to mean today.

A `contradicted` or `supported` result requires a reviewed primary/institutional publisher, a direct-evidence excerpt, and sufficiently strong source-quality/relation choices. The initial model-probability gates are 0.8—conservative development settings, **not calibrated factual certainty**. Conflicting evidence, missing scope, and unclear comparisons go to review instead.

Possible statuses: `contradicted`, `supported`, `conflicting`, `needs_context`, `needs_review`, and `insufficient_evidence`. No source or inadequate evidence means no falsehood conclusion. Neutral quotations/rebuttals must not inherit the quoted claim's error. The function never invents URLs or passages.

### Return value and audit files

The function returns an `EvidenceReport` with search/cache/Jev call counts, groups, per-target assessments, exact retrieved excerpts and URLs, original timestamps, and pending targets. It saves the plan, Tavily calls/replies, Jev calls/replies, and `evidence.json` under `results/<videoId>/evidence-<timestamp>/`. Authorization headers and keys are never written. The transient cache is separate from the audited run files.

The report is an internal evidence assessment, not the final integer Overlay response. A useful UI can show the claim, timestamp, evidence status, source title/link, and retrieved excerpt; it must not turn every score above 2 into “proven fake.”

### Evidence source format for the future API

A retrieved source is an `EvidenceSource`. After Jev compares it with a claim, it becomes an `EvidenceCitation`: the same source plus `quality`, `relation`, and their model probabilities. These types are exported from `process/tavily.ts`.

Example per-sentence assessment: `citations[0]` shows the complete source format. The `excerpt` placeholder stands for the actual stored source text.

```json
{
  "videoId": "zmfRG8-RHEI",
  "sentenceId": "s0315",
  "targetId": "s0315",
  "text": "Yes I assert, that there is no connection whatsoever, between CO₂ and climate change.",
  "start": 1873.829,
  "end": 1880.7089999999998,
  "screeningScore": 2.86,
  "evidenceStatus": "contradicted",
  "citations": [
    {
      "id": "E1",
      "url": "https://weather.metoffice.gov.uk/learn-about/weather/types-of-weather/temperature/heatwave",
      "title": "What is a heatwave? - Met Office",
      "publisher": "gov.uk",
      "tier": "primary",
      "excerpt": "<actual retrieved source excerpt>",
      "excerptTruncated": false,
      "publicationDateEstimate": null,
      "retrievedAt": "2026-10-17T07:45:10.239Z",
      "quality": "direct_evidence",
      "relation": "contradicts",
      "relationProbability": 0.88,
      "sourceQualityProbability": 0.94
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Source ID within this research group. It is not globally unique; use the URL to identify a source across groups. |
| `url`, `title` | Actual URL and title returned by Tavily, not generated by Jev. |
| `publisher` | Domain matched in our reviewed source registry, such as `gov.uk`. |
| `tier` | Registry hint: `primary` or `secondary`. This does not by itself establish credibility or truth. |
| `excerpt` | Retrieved text used for this assessment. It can contain Tavily's `[...]` separators between source chunks; it is not a newly generated explanation. |
| `excerptTruncated` | Whether our code shortened that retrieved excerpt. `false` does **not** mean the complete web page was supplied. |
| `publicationDateEstimate` | Tavily's estimated publication/update date string, or `null` when unknown. Not guaranteed to be the original publication date. |
| `retrievedAt` | ISO timestamp of the original search. Cache hits retain that original retrieval time. |
| `quality` | Jev's classification: `direct_evidence`, `secondary_summary`, or `unusable`. |
| `relation` | Relation to this exact claim: `contradicts`, `supports`, `qualifies`, or `insufficient`. |
| `relationProbability`, `sourceQualityProbability` | Model probabilities for the selected labels, used as review gates—not probabilities that a real-world claim is false. |

The **same source can have a different relation for each claim**. A source about heatwaves might contradict a claim that CO₂ has no climate effect, but provide insufficient evidence about how every climate model works.

Each source list belongs to an `EvidenceAssessment`:

```typescript
import type { EvidenceAssessment, EvidenceCitation } from './process/tavily';

// EvidenceAssessment contains:
// videoId, sentenceId, targetId, text, start, end,
// screeningScore, evidenceStatus, citations: EvidenceCitation[]
```

- `sentenceId` identifies the original transcript sentence; `targetId` can identify a split part.
- `start` / `end` are the source sentence's original seconds, not invented word-level timestamps.
- `screeningScore` is the earlier 0–3 concern score, not an evidence-backed final score.
- `evidenceStatus` is `contradicted`, `supported`, `conflicting`, `needs_context`, `needs_review`, or `insufficient_evidence`.
- `citations` contains usable, relevant comparisons. It can be empty; that does not establish the claim is true.

The function returns all assessments inside `EvidenceReport.assessments`; `EvidenceReport.pending` records targets not checked because of budgets or missing context. For a public API, return the needed assessment/citation fields rather than exposing the report's internal filesystem `directory` or raw provider replies.

This evidence shape is **internal to Processing**. The planned Overlay response still has exactly `{timestamp, sentence, score, sources}`. A future adapter must choose appropriate evidence-backed outcomes, map `start` to `timestamp`, retain original sentence text, and select actual citation URLs for `sources`. Final integer score rules are not yet defined; do not silently round the screening score or map all retrieved links into a falsehood warning.

### Bounded live example

One actual Tavily REST search supplied sources for three related CO₂ claims. Rechecks reused the cache with **zero additional Tavily searches**. In the final assessment:

- “No connection whatsoever between CO₂ and climate change” → `contradicted`, citing the UK Met Office's CO₂/heatwave evidence.
- “CO₂ is quite unimportant” → `needs_review`; its source relation was less clear.
- “All climate models are based on the assumption…” → `insufficient_evidence` from these excerpts.

This demonstrates why a shared search must not produce a shared verdict. Four other targets remained pending under the one-search test budget. Final example: `results/zmfRG8-RHEI/evidence-20261017T074751086Z/evidence.json`.

## Saved mock evidence cases

All 13 videos in `results/summary.json` now have captured evidence-stage fixtures. **The original Jev screening results were reused unchanged**, not rerun. These are saved application outputs for mock playback, not hand-labeled factual ground truth.

- **Case index and timings:** `results/evidence-summary.json`.
- **Stable mock files:** `results/evidence-fixtures/<videoId>.json`.
- **Full audit files:** each index entry's `evidence` path points to the timestamped run with Tavily/Jev requests and responses.

Each mock file contains `videoId`, `language`, `videoUrl`, the relative transcript/screening/evidence paths, `maxSearches`, `eligibleClaims`, `assessments`, and `pending`. Assessment/citation fields follow the format above. Read these files directly for mocks; do not call `verifySuspicions()` again during mock playback. No mock HTTP route has been added yet.

The evidence-only batch took **86.24 seconds total**, making **27 Tavily searches**, reusing **3 search-cache hits**, and making **28 source-based Jev assessment calls**. It made **zero original screening calls**.

With the three-group-per-video limit, **35 of 179 eligible targets were assessed**: 6 `contradicted`, 25 `insufficient_evidence`, 1 `needs_context`, and 3 `needs_review`. The remaining **144 targets are explicitly pending**: 85 due to the search budget, 55 due to the candidate cap, and 4 due to oversized context. In particular, `7wFWgopJP5Q` has pending-only results; its search replies are saved, but its context exceeded the assessment budget. **All videos have fixture files; not all claims are verified or have usable citations.**

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
