# Process

Processing shares Extract's Node.js runtime, root dependencies, and TypeScript configuration. Jev screening and a bounded Tavily/Jev evidence API are implemented; HTTP endpoint integration remains TODO. The planned server runs Extract and then Process before returning results to Overlay.

- `preprocess.ts`: validates the shared transcript, selects English or Traditional Chinese prompts, splits oversized Mandarin entries, and builds context windows.
- `jev_call.ts`: exports callable processing/API functions and provides the CLI. It records timing and saves ranked concerns with original source IDs and times.
- `tavily.ts`: exports `verifySuspicions(transcript, targets, { maxSearches: 3 })`. It groups targets for shared searches, caches results, and checks each claim separately against retrieved excerpts.

```bash
npm run preprocess -- examples/transcripts/OwqIy8Ikv-c.json
npm run jev -- examples/transcripts/OwqIy8Ikv-c.json
npm run jev -- examples/transcripts/7wFWgopJP5Q.json
```

Chinese prompts are selected automatically. Importing `jev_call.ts` does not execute the CLI or call the API. A server handler can call its exported functions directly. See [JEV.md](../JEV.md) for usage, prompts, scoring, and saved results.

The input is the validated `Transcript` from `shared/transcript.ts`. Current fractional concern scores and evidence assessments are internal results, **not** the final integer scores below. Tavily uses `TAVILY_API_KEY` from the server environment or root `.env`; it runs only when `verifySuspicions()` is explicitly called. See [JEV.md](../JEV.md#second-stage-tavily-evidence-api) for budgets, source checks, and pending outcomes.

## Required server → Overlay output

```json
[
  {
    "timestamp": 42.5,
    "sentence": "Original transcript sentence",
    "score": 2,
    "sources": ["https://factcheck.org/..."]
  }
]
```

- `timestamp`: original source sentence's `start`, in seconds.
- `sentence`: original source sentence's complete `text`.
- `score`: an integer `0 | 1 | 2 | 3`; final meanings/reporting rules are still to be defined.
- `sources`: HTTP(S) URLs; an empty array is permitted by the proposed contract.

Return exactly these fields, without a wrapper or the old `explanation` field. Preserve IDs internally, map split targets back to their source sentences, and order results by timestamp. A successful check with no reportable results returns `[]`; extraction and processing failures remain errors.

## Remaining work

- Implement `shared/overlay-results.ts`, its JSON Schema, runtime validation, and contract tests. These files are not yet present in the repository.
- Define final score meanings. Do not silently round fractional screening scores into final Overlay judgments.
- Connect the existing `verifySuspicions()` evidence API to the server workflow and final Overlay reporting policy.
- Integrate Process into the shared HTTP server. Current `POST /extract` only saves a transcript and returns metadata.
- Add server integration tests for output shape, source text/timestamps, ordering, scoring, and failures.
