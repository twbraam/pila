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

Implemented in [`packages/factcheck`](./packages/factcheck) as `factCheck(transcript, options)`.

1. **Find claims with Jev:** one request asks, for every sentence, whether it is a specific factual claim that can be checked. The top 5 are kept (configurable). Jev has no world knowledge, so it picks *checkable* sentences; it does not judge truth on its own.
2. **Find evidence with Tavily:** one search for reviews of the whole video (title + channel + "fact check"), plus one search per claim. Fact-checker domains are preferred; YouTube and copies of the video's own transcript are dropped.
3. **Assess with Jev:** per claim, one request asks for a verdict, what each source says about the claim, and which sentence of each source states its conclusion.
4. **Decide in code:** trusted fact-checkers win; unclear or inconsistent answers become `unknown`.

**Input:** a `Transcript`, plus the video's `title` and `channel` (they find published reviews of the video, the best evidence). **Output:** one `FactCheckResult` per checked sentence, streamed to `onResult` as each check completes and returned together at the end. Sentences that were not checked produce no result; that does not establish that they are true.

### 3. Overlay

- Match warnings to sentences using the video ID and sentence ID.
- Use the sentence timestamps and current playback position to show the relevant warning.
- Tell the user **“This statement is probably false”** and display a clickable link to the selected source for more information.

**Input:** the `Transcript`, `FactCheckResult`s from Processing, and the current playback position. Show a warning only for results with `verdict: "misinformation"`; use `sources[0]` as the link and `explanation` as the detail text.

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

type FactCheckResult = {
  videoId: string;
  sentenceId: string;
  startSeconds: number;
  endSeconds: number;
  sentence: string;                 // as given in the Transcript
  verdict: "misinformation" | "verified" | "unknown";
  confidence: number;               // 0-1
  explanation: string;              // template + a quote from the best source, e.g.
                                    // Science Feedback says this claim is false: “…”
  sources: { title: string; url: string }[];  // best first; empty when nothing relevant was found
};
```

- `misinformation`: a source (usually a fact-checker) says the claim is false.
- `verified`: a source confirms the claim.
- `unknown`: no relevant evidence, unclear or conflicting sources, a misleading-but-not-false claim, or a failed check. `explanation` says which.
- `confidence` is how sure Processing is of its finding. For `unknown` it can be high (for example, a clearly *misleading* claim), so read it together with `explanation`.
- `explanation`, `sources[].title`, and `sources[].url` contain text from the web. Overlay must render them as plain text (`textContent`), never as HTML, and should only link `https:` URLs.

Example:

```json
{
  "videoId": "OwqIy8Ikv-c",
  "sentenceId": "OwqIy8Ikv-c-16",
  "startSeconds": 104.71,
  "endSeconds": 111.79,
  "sentence": "None of these is fully understood, and there is no evidence that CO2 emissions are the dominant factor.",
  "verdict": "misinformation",
  "confidence": 0.93,
  "explanation": "Science Feedback says this claim is false: “In the video, former MIT Professor Richard Lindzen claims “there is no evidence that CO2 emissions are the dominant factor” in climate change. This is false.”",
  "sources": [
    {
      "title": "Video from PragerU makes several incorrect and misleading claims about climate change - Science Feedback",
      "url": "https://science.feedback.org/review/video-from-prageru-makes-several-incorrect-and-misleading-claims-about-climate-change-richard-lindzen"
    }
  ]
}
```

The example is illustrative; it has not been produced by a live Jev run yet.

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
