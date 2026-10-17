# Pila

A Chrome extension that checks YouTube subtitles for potential misinformation and shows evidence links during video playback.

## Proof of Concept

The POC will fetch the **whole transcript when a user opens a YouTube video**. Ingestion assembles subtitle fragments into complete sentences. All three modules run in the **TypeScript extension**, with Jev and Tavily requests handled by the background service worker.

This is the planned architecture. The modules can be built in parallel using the shared data contracts below and mock inputs and outputs.

## Modules

### 1. Ingestion

- Discover and fetch the video's available subtitles, even when the user has closed captions (CC) disabled.
- Assemble subtitle fragments into complete sentences, preserving their playback timestamps.
- Return the full transcript as JSON, with a video ID and a stable ID for each sentence.

**Output:** a `Transcript` for Processing and Overlay.

**Server side:** the hosted API calls a transcript function, `getTranscript(videoId)`, that returns the caption
segments (`{ text, start, duration }`, as in [`ref/transcript.json`](./ref/transcript.json)). A teammate is building
that function; until it ships, the API uses the sample transcript for every video (response header
`x-pila-transcript-source: mock`). Contract: [`apps/api/src/transcripts/provider.ts`](./apps/api/src/transcripts/provider.ts).

### 2. Processing

Hosted by [`apps/api`](./apps/api) at **`https://d3tuhog92nak7r.cloudfront.net`**. The extension calls
`POST /factcheck` with `Authorization: Bearer <token>` and `{ "videoId": "<11-char YouTube ID>" }`, and gets a bare
`FactCheckItem[]` (below). The API chains two functions:

1. `getTranscript(videoId)` returns the caption segments (`{ text, start, duration }`, as in
   [`ref/transcript.json`](./ref/transcript.json)). Contract: [`apps/api/src/transcripts/provider.ts`](./apps/api/src/transcripts/provider.ts).
2. `factCheck(transcript)` turns them into `FactCheckItem[]`. Contract: [`apps/api/src/factcheck/provider.ts`](./apps/api/src/factcheck/provider.ts).

Teammates are building both. Until they ship, both are **mocks**: every video gets the sample transcript and the same
five fixed items (response headers `x-pila-transcript-source: mock`, `x-pila-factcheck-source: mock`).

[`packages/factcheck`](./packages/factcheck) is our earlier Jev + Tavily implementation (`FactCheckResult`, see its
[workflow](./packages/factcheck/docs/workflow.md)). The API no longer calls it.

### 3. Overlay

- Use `timestamp` and the current playback position to show the relevant item.
- Tell the user **“This statement is probably false”** and display a clickable link to `sources[0]` for more information.

**Input:** `FactCheckItem[]` from the API and the current playback position. What each `score` means (and which
scores get a warning) is defined by the fact-check function's owner.

## Shared Data Contracts

These TypeScript types describe the JSON exchanged between modules. Timestamps are in seconds from the beginning of the video.

```ts
// POST /factcheck response body
type FactCheckItem = {
  timestamp: number;   // seconds from the video start
  sentence: string;    // excerpt from the transcript
  score: 0 | 1 | 2 | 3;
  sources: string[];   // http(s) URLs, best first; may be empty
};

// What getTranscript returns (ref/transcript.json is the segments array)
type VideoTranscript = {
  videoId: string;
  segments: { text: string; start: number; duration: number }[];
  language?: "en" | "zh";
};
```

- `sentence` and `sources` may contain text from the web. Overlay must render them as plain text (`textContent`),
  never as HTML, and should only link `https:` URLs. The API rejects non-http(s) URLs.

Example (from the mock):

```json
[
  {
    "timestamp": 104.71,
    "sentence": "None of these is fully understood, and there is no evidence that CO2 emissions are the dominant factor.",
    "score": 3,
    "sources": [
      "https://climatefeedback.org/evaluation/video-from-prageru-makes-several-incorrect-and-misleading-claims-about-climate-change-richard-lindzen"
    ]
  }
]
```

Ingestion can be developed against sample subtitle data, Processing against fixture transcripts, and Overlay against the mock API. This lets each module progress before the others are connected.

## Tech Stack

- **TypeScript + WXT (Manifest V3)** — Chrome extension framework.
- **Content scripts + page-context bridge** — discover subtitles and monitor playback.
- **Background service worker + Fetch API** — retrieve captions and call our hosted API.
- **Hosted API (Hono on AWS Lambda behind CloudFront)** — chains the transcript and fact-check functions; see [`infra/aws`](./infra/aws/README.md).
- **Jev + Tavily** — detect potential misinformation, search for evidence, and select a supporting source.
- **Chrome messaging + storage** — internal communication and settings.

## Technical Considerations

Caption extraction relies on YouTube's undocumented interfaces and may not work for every video. Missing subtitles or failed checks must not produce misinformation warnings. The extension must handle playback synchronization, seeking, deduplication, and checks that finish after a sentence has played. Changing videos must clear old warnings and ignore results belonging to the previous video. Any service credentials live only on the server (AWS SSM); the extension needs only the API token.

## Example videos

See [youtube_videos](./examples/youtube_videos.md)
