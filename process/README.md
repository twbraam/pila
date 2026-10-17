# Process

Processing shares Extract's Node.js runtime, root dependencies, and TypeScript configuration. Jev screening is implemented; evidence checking and HTTP endpoint integration remain TODO. The planned server runs Extract and then Process before returning results to Overlay.

- `preprocess.ts`: validates the shared transcript, selects English or Traditional Chinese prompts, splits oversized Mandarin entries, and builds context windows.
- `jev_call.ts`: exports callable processing/API functions and provides the CLI. It records timing and saves ranked concerns with original source IDs and times.

```bash
npm run preprocess -- examples/transcripts/OwqIy8Ikv-c.json
npm run jev -- examples/transcripts/OwqIy8Ikv-c.json
npm run jev -- examples/transcripts/7wFWgopJP5Q.json
```

Chinese prompts are selected automatically. Importing `jev_call.ts` does not execute the CLI or call the API. A server handler can call its exported functions directly. See [JEV.md](../JEV.md) for usage, prompts, scoring, and saved results.

The input is the validated `Transcript` from `shared/transcript.ts`. Current fractional concern scores are internal screening results, **not** the final integer scores below.

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
- Add Tavily evidence retrieval and Jev evidence assessment to the existing screening step.
- Integrate Process into the shared HTTP server. Current `POST /extract` only saves a transcript and returns metadata.
- Add server integration tests for output shape, source text/timestamps, ordering, scoring, and failures.
