# Process

Processing shares Extract's Node.js runtime, root dependencies, and TypeScript configuration. It consumes the validated `Transcript` contract from `shared/transcript.ts`, preserving sentence IDs, text, and `start`/`end` timestamps.

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

See [JEV.md](../JEV.md) for prompts, CLI options, scoring, and the `results/` layout. This implementation screens candidates; evidence retrieval and evidence-backed Overlay warnings remain future steps.
