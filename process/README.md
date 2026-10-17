# Process

The Process step will live here and share the Node.js server runtime, root `package.json`, and TypeScript configuration with Extract. Its implementation is planned.

Input is the whole-video `Transcript` produced by Extract. Import the shared contract directly, so Process does not depend on the caption downloader:

```typescript
import { assertTranscript } from '../shared/transcript';
import type { Transcript } from '../shared/transcript';
```

Use `assertTranscript()` to validate JSON received across a file or request boundary. The portable schema is [shared/transcript.schema.json](../shared/transcript.schema.json), and a complete input example is [examples/transcripts/extracted.json](../examples/transcripts/extracted.json).

Process will detect candidate misinformation with Jev, retrieve evidence with Tavily, and emit warnings linked to the original `videoId` and sentence `id`. Preserve the transcript's IDs, text, and timestamps for Overlay. The warning contract will be defined with the Process implementation.
