# Pila

A Chrome extension that checks YouTube subtitles for potential misinformation and shows evidence links during video playback.

## Tech Stack

- **TypeScript + WXT (Manifest V3)** — Chrome extension framework.
- **Content scripts + page-context bridge** — discover subtitles and monitor playback.
- **Background service worker + Fetch API** — retrieve captions and communicate with Jev.
- **Chrome messaging + storage** — internal communication and settings.


## Proof of Concept

The POC will fetch the **whole transcript when a user opens a YouTube video**. Ingestion assembles subtitle fragments into complete sentences. All three modules run in the **TypeScript extension**, with Jev and Tavily requests handled by the background service worker.

This is the planned architecture. The modules can be built in parallel using the shared data contracts below and mock inputs and outputs.

## Modules

### 1. Ingestion

A standalone TypeScript CLI (`src/`) that turns a single YouTube video into subtitles using **only Gemini**. There is no captions scraper, so it works the same whether or not the uploader enabled captions.

```bash
npm install
export GEMINI_API_KEY=your_key        # or put it in a .env file
npm run transcript -- <video-url-or-id> --format srt --out video.srt
```

| Option | Description |
| --- | --- |
| `--format srt\|vtt\|text\|json` | Output format (default `srt`) |
| `--out <file>` | Write to a file instead of stdout |

Env: `GEMINI_API_KEY` (required), `GEMINI_MODEL` (default `gemini-2.5-flash`).

#### How it works

```mermaid
flowchart LR
    A["YouTube URL or ID"] --> B["Extract video ID"]
    B --> C["Send the video link to Gemini"]
    C --> D["Gemini watches and listens,<br/>returns text with start times"]
    D --> E["Add an end time to each line"]
    E --> F["Save as SRT, VTT, text or JSON"]
```

1. **Extract the ID.** Accepts a plain ID or a `watch`, `youtu.be`, `shorts`, `embed` or `live` link.
2. **Send the link to Gemini.** The video URL goes straight to the Gemini API. Nothing is downloaded.
3. **Gemini transcribes.** It processes the video's audio and returns a JSON list of `{ start, text }`.
4. **Add end times.** Gemini gives only start times, so each line ends where the next one starts (the last line gets 3 s).
5. **Write the file.** Cues are formatted as SRT or VTT, or saved as plain text or JSON.

#### What Gemini does

```mermaid
sequenceDiagram
    participant CLI
    participant Gemini
    CLI->>Gemini: video URL + "transcribe, return JSON"
    Note right of Gemini: Reads the video and<br/>transcribes the speech
    Gemini-->>CLI: [ { start, text }, ... ]
    Note left of CLI: Add end times,<br/>write SRT / VTT / text / JSON
```

The request asks for JSON with a fixed shape (`responseMimeType: application/json` plus a `responseSchema`), so the reply can be parsed directly with no text cleanup.

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

## Example videos

See [example_videos](./example_videos/README.md)
