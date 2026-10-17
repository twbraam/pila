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

### 2. Processing

For every sentence in the transcript:

1. **Detect with Jev:** ask whether the sentence contains misinformation. If no, continue with the next sentence. A yes is a candidate for further checking.
2. **Find and assess evidence:** use Tavily to search for a list of evidence links, then ask Jev to assess the results and choose the best source supporting the conclusion that the statement is false. If a suitable source is found, emit a warning for Overlay. If no good evidence is found, skip the warning and continue with the next sentence.

**Input:** a `Transcript`. **Output:** `MisinformationWarning` results as checks complete. A skipped sentence produces no warning; that does not establish that it is true.

### 3. Overlay

- Match warnings to sentences using the video ID and sentence ID.
- Use the sentence timestamps and current playback position to show the relevant warning.
- Tell the user **“This statement is probably false”** and display a clickable link to the selected source for more information.

**Input:** the `Transcript`, warnings from Processing, and the current playback position. Only sentences with evidence from Processing produce a warning.

## Shared Data Contracts

These TypeScript types describe the JSON exchanged between modules. Timestamps are in seconds from the beginning of the video; sentence IDs are unique and stable within a transcript.

```ts
type SubtitleSentence = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

type Transcript = {
  videoId: string;
  sentences: SubtitleSentence[];
};

type MisinformationWarning = {
  videoId: string;
  sentenceId: string;
  source: {
    title: string;
    url: string;
  };
};
```

Ingestion can be developed against sample subtitle data, Processing against fixture transcripts, and Overlay against fixture transcripts and warnings. This lets each module progress before the others are connected.

## Tech Stack

- **TypeScript + WXT (Manifest V3)** — Chrome extension framework.
- **Content scripts + page-context bridge** — discover subtitles and monitor playback.
- **Background service worker + Fetch API** — retrieve captions and communicate with Jev and Tavily.
- **Jev + Tavily** — detect potential misinformation, search for evidence, and select a supporting source.
- **Chrome messaging + storage** — internal communication and settings.

## Technical Considerations

Caption extraction relies on YouTube's undocumented interfaces and may not work for every video. Missing subtitles or failed checks must not produce misinformation warnings. The extension must handle playback synchronization, seeking, deduplication, and checks that finish after a sentence has played. Changing videos must clear old warnings and ignore results belonging to the previous video. Jev and Tavily credentials must be configured for the POC.

## Example videos

See [youtube_videos](./examples/youtube_videos.md)
