# Process

The Process step will live here and run on the **same Node.js server as Extract**, sharing the root `package.json` and TypeScript configuration. Its implementation and server integration are **TODO**. The server will run Extract and then Process, and return the completed result array to Overlay.

Input is the whole-video `Transcript` produced by Extract. Import the shared contract directly, so Process does not depend on the caption downloader:

```typescript
import { assertTranscript } from '../shared/transcript';
import type { Transcript } from '../shared/transcript';
```

Use `assertTranscript()` to validate JSON received across a file or request boundary. The portable schema is [shared/transcript.schema.json](../shared/transcript.schema.json), and a complete input example is [examples/transcripts/OwqIy8Ikv-c.json](../examples/transcripts/OwqIy8Ikv-c.json).

Process is planned to identify statements to check with Jev, retrieve evidence with Tavily, and return scored results. The meaning of each score and the scoring/reporting criteria will be specified later. Skipping a statement does not confirm it.

## Output contract

The shared output contract is implemented in [`shared/overlay-results.ts`](../shared/overlay-results.ts), with a portable [JSON Schema](../shared/overlay-results.schema.json). The server → Overlay response must be a top-level JSON array with exactly these fields per result:

```json
[
  {
    "timestamp": 42.5,
    "sentence": "Sample excerpt from video speech or transcript",
    "score": 2,
    "sources": ["https://factcheck.org/..."]
  }
]
```

- `timestamp`: the original sentence's `start`, in seconds from the beginning of the video.
- `sentence`: the original sentence's `text`.
- `score`: an integer from 0 through 3 (`0 | 1 | 2 | 3`); meanings will be specified later.
- `sources`: an array of HTTP(S) source URL strings. The contract permits an empty array.

Keep the original `videoId` and sentence `id` association internally while processing. Overlay receives the result array for the video it requested, without a wrapper, internal transcript, IDs, or file paths. Return results in nondecreasing timestamp order, or `[]` when a successful check produces no reportable results. Extraction and processing failures must remain errors.

Use the shared types and runtime validator at the output boundary:

```typescript
import { assertOverlayResults } from '../shared/overlay-results';
import type { OverlayResult, OverlayResults } from '../shared/overlay-results';
```

`assertOverlayResults()` rejects extra or missing fields (including the old `explanation` field), invalid timestamps, blank sentence text, scores outside the integer range 0–3, invalid source URLs, and results out of timestamp order. Contract tests are included in `npm test`; Process itself is still TODO.

## Implementation TODO

- Define score meanings and scoring/reporting criteria for the [server → Overlay contract](../README.md#output-contract-server--overlay).
- Implement Jev/Tavily checks and map the internal `Transcript` sentences to the required result fields.
- Integrate Process into the shared server so the client receives the array after both extraction and processing complete. The current `POST /extract` endpoint only saves a transcript and returns metadata; it does not implement this response yet.
- Add server integration tests for original text/timestamp mapping, scoring, empty results, and failures once Process is implemented.
