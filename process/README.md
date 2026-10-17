# Process

Processing runs on the **same Node.js server as Extract**, sharing the root dependencies and TypeScript configuration. The Jev screening CLI is implemented; evidence checking and server integration remain **TODO**. Processing consumes the validated `Transcript` contract from `shared/transcript.ts`, preserving source sentence IDs, text, and time ranges. The planned server integration will run Extract and then Process, returning the completed result array to Overlay.

- `preprocess.ts`: automatically selects English or Traditional Chinese prompts, splits oversized Mandarin entries without losing source IDs/times, and builds context windows and Jev requests.
- `jev_call.ts`: calls Jev, records timing, and saves ranked, timestamped concerns.

```bash
# Prepare only
npm run preprocess -- examples/transcripts/OwqIy8Ikv-c.json

# Call Jev (defaults: automatic language, score, threshold 2, batch size 64, context 4000 tokens)
npm run jev -- examples/transcripts/OwqIy8Ikv-c.json
```

For Chinese transcripts, the same command works without a language flag:

```bash
npm run jev -- examples/transcripts/7wFWgopJP5Q.json
```

Use `assertTranscript()` to validate JSON received across a file or request boundary. The portable schema is [shared/transcript.schema.json](../shared/transcript.schema.json), and a complete input example is [examples/transcripts/OwqIy8Ikv-c.json](../examples/transcripts/OwqIy8Ikv-c.json).

See [JEV.md](../JEV.md) for prompts, CLI options, scoring, and the `results/` layout. The current CLI writes ranked review candidates, not the final server response.

The complete pipeline will use the existing Jev screening step, retrieve evidence with Tavily, and use Jev to assess whether each statement should be flagged or confirmed. Include an Overlay result only when suitable evidence supports the explanation. Skipping a statement does not confirm it.

## Required output (TODO)

The server → Overlay response must be a top-level JSON array with exactly these fields per result:

```json
[
  {
    "timestamp": 42.5,
    "sentence": "Sample excerpt from video speech or transcript",
    "explanation": "Context explaining why this statement is flagged or confirmed",
    "sources": ["https://factcheck.org/..."]
  }
]
```

- `timestamp`: the original sentence's `start`, in seconds from the beginning of the video.
- `sentence`: the original sentence's `text`.
- `explanation`: context and evidence explaining why the statement is flagged or confirmed.
- `sources`: an array of evidence URL strings supporting the explanation.

Keep the original `videoId` and sentence `id` association internally while processing. Overlay receives the result array for the video it requested, without a wrapper, internal transcript, IDs, or file paths. Return results in nondecreasing timestamp order, or `[]` when a successful check produces no reportable results. Extraction and processing failures must remain errors.

## Implementation TODO

- Define the result type, JSON Schema, and runtime validator in `shared/`, following the [server → Overlay contract](../README.md#output-contract-server--overlay-todo).
- Add Tavily evidence retrieval and Jev evidence assessment to the existing screening step. Map targets back to their original source sentence text and start time, including targets split from long Chinese entries.
- Integrate Process into the shared server so the client receives the array after both extraction and processing complete. The current `POST /extract` endpoint only saves a transcript and returns metadata; it does not implement this response yet.
- Add contract and server integration tests for the exact response shape, original text/timestamp mapping, result ordering, evidence-backed flagged or confirmed explanations, empty results, and failures.
