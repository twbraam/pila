# Using the library in the Chrome extension

For the extension team. The library does the fact-checking; the extension gets the
transcript, holds the keys, and shows the report.

## Where it runs

Run the library **in the extension's service worker** only.

- Content scripts are bound by the page's CORS rules; the service worker is not, as long
  as the hosts are in `host_permissions`.
- Jev's SDK refuses to run in pages (popup, side panel) unless forced, because keys
  would be exposed there.
- Both APIs accept requests from a `chrome-extension://` origin (tested 2026-10-17).

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "sidePanel"],
  "host_permissions": [
    "https://api.typesafe.ai/*",
    "https://api.tavily.com/*",
    "https://www.youtube.com/*"
  ]
}
```

## Wiring

```ts
// background.ts (service worker)
import { createFactChecker } from "@pila/factcheck";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "check-video") return;
  (async () => {
    const { typesafeApiKey, tavilyApiKey } = await chrome.storage.local.get(["typesafeApiKey", "tavilyApiKey"]);
    const checker = createFactChecker({ typesafeApiKey, tavilyApiKey });
    const report = await checker.checkVideo(msg.input);
    await chrome.storage.session.set({ [`report:${msg.input.video.id}`]: report });
    sendResponse({ ok: true, report });
  })().catch((err) => sendResponse({ ok: false, error: { name: err.name, message: err.message } }));
  return true; // keep the channel open for the async reply
});
```

- Validate `msg` with a schema before using it. Pages on YouTube can try to send fake
  messages.
- Cache reports per video ID in `chrome.storage.session`. Service workers stop after
  ~30 s idle, so don't keep results in global variables.
- A run takes ~5-10 s. Chrome stops the worker after 30 s with no events or extension
  API calls, or if one `fetch()` response takes over 30 s. Our calls are well under
  that. Sending progress (`onProgress` -> `chrome.runtime.sendMessage`) to the UI also
  calls an extension API, which resets the timer.
- Keys: an options page writes them to `chrome.storage.local`. Never bundle a key.

## Getting the transcript (extension team)

The library needs `TranscriptSegment[]` (`{ text, start, duration }`) plus video ID,
title, and channel. Getting it is the extension team's job. Notes from research:

- The official YouTube Data API `captions.download` needs the video owner's permission.
  It can't be used for other people's videos.
- Common approach: read caption tracks from the watch page's player data
  (`captionTracks` in `ytInitialPlayerResponse`) and fetch the track. This is
  unofficial, can break when YouTube changes, and may need extra tokens.
  Needs its own spike.
- Fallback for the demo: load a saved transcript JSON (like `ref/transcript.json`).
- Title and channel improve evidence search a lot (see [02](./02-tavily-evidence-search.md#queries)).
  Always pass them.

## Showing results

- Each claim has `start` (seconds). Link to `https://www.youtube.com/watch?v=<id>&t=<start>s`
  or seek the player.
- Show the label, the confidence, and each source with its stance and link.
- Render evidence as plain text. Allow only `https:` links.
- Show "Not sure" and "Not enough evidence" as normal outcomes, not errors.
