# Process

The Process step will live here and run on the **same Node.js server as Extract**, sharing the root `package.json` and TypeScript configuration. Its implementation and server integration are **TODO**. The server will run Extract and then Process, and return the completed result array to Overlay.

Input is the whole-video `Transcript` produced by Extract. Import the shared contract directly, so Process does not depend on the caption downloader:

```typescript
import { assertTranscript } from '../shared/transcript';
import type { Transcript } from '../shared/transcript';
```

Use `assertTranscript()` to validate JSON received across a file or request boundary. The portable schema is [shared/transcript.schema.json](../shared/transcript.schema.json), and a complete input example is [examples/transcripts/OwqIy8Ikv-c.json](../examples/transcripts/OwqIy8Ikv-c.json).

Process will identify statements to check with Jev, retrieve evidence with Tavily, and use Jev to assess whether each statement should be flagged or confirmed. Include a result only when suitable evidence supports the explanation. Skipping a statement does not confirm it.

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
- Implement Jev/Tavily checks and map the internal `Transcript` sentences to the required result fields.
- Integrate Process into the shared server so the client receives the array after both extraction and processing complete. The current `POST /extract` endpoint only saves a transcript and returns metadata; it does not implement this response yet.
- Add contract and server integration tests for the exact response shape, original text/timestamp mapping, result ordering, evidence-backed flagged or confirmed explanations, empty results, and failures.
