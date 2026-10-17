# Building the Chrome extension

## Manifest V3 basics

MV3 is Chrome's current extension format. The parts we need:

| Part | Job in our extension |
| - | - |
| Service worker (`background`) | Context menu, evidence search, Jev calls, result cache. Holds the API key. |
| Side panel (`chrome.sidePanel`) | Claim input box + result. Stays open while the user reads, unlike a popup. |
| Options page | Each person pastes their Jev key (and optional Google key). |
| Content script | Not needed for v1: the context menu already gives us the selected text. |

Key rules:

- **Network calls go in the service worker.** Content scripts and pages are bound by
  CORS. The service worker is not, as long as the host is in `host_permissions`.
- **Service workers are short-lived.** Chrome stops them after about 30 s idle. Don't
  keep state in global variables. Use `chrome.storage.session` (memory only) for the
  per-claim cache and `chrome.storage.local` for keys and settings.
- **Message handlers must be narrow.** Accept only known message types, validated with a
  schema (zod). Never fetch a URL given in a message.

## Permissions (PoC)

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "138",
  "permissions": ["contextMenus", "sidePanel", "storage"],
  "host_permissions": [
    "https://api.typesafe.ai/*",
    "https://api.cofacts.tw/*",
    "https://factchecktools.googleapis.com/*"
  ]
}
```

No access to page content is requested. Selected text comes from the context menu
click, so the extension never reads pages on its own. Chrome 138 is for the built-in
Translator API (only needed for the Chinese experiment).

## Getting the claim

1. **Right-click a selection -> "Verify with Jev"** (main path):
   ```ts
   chrome.runtime.onInstalled.addListener(() => {
     chrome.contextMenus.create({ id: "verify", title: "Verify with Jev", contexts: ["selection"] });
   });
   chrome.contextMenus.onClicked.addListener((info, tab) => {
     if (info.menuItemId !== "verify" || !info.selectionText || !tab?.id) return;
     chrome.sidePanel.open({ tabId: tab.id }); // must run inside the click handler
     // then verify(info.selectionText)
   });
   ```
   `chrome.sidePanel.open` only works directly in response to a user action, so call it
   before any `await`.
2. **Type or paste a claim in the side panel** (backup, and handy for demos).
3. Later (not v1): read a whole article with `@mozilla/readability`, split it into
   sentences with `Intl.Segmenter(lang, { granularity: "sentence" })` (handles Chinese
   too), and ask Jev one `noul` per sentence: "Is this a specific factual claim that can
   be checked?" Then verify the top 3.

Trim the claim and cap its length (e.g. 500 characters). A long selection is usually
several claims; ask the user to pick one.

## Evidence sources

| Source | Languages | Key needed | What it returns | Notes |
| - | - | - | - | - |
| **Cofacts** `POST https://api.cofacts.tw/graphql` | Traditional Chinese | No | Matching rumors, each with replies labeled `RUMOR` / `NOT_RUMOR` / `OPINIONATED` / `NOT_ARTICLE`, a reply text, and reference links | Tested: a Chinese query found the Morris Chang letter as `RUMOR`, citing Taiwan FactCheck Center. Credit Cofacts in the UI; confirm their data license (believed CC BY-SA, not verified). |
| **Google Fact Check Tools** `GET https://factchecktools.googleapis.com/v1alpha1/claims:search?query=...&languageCode=...&key=...` | Many (en, zh) | Google Cloud API key (free) | Published fact-checks: publisher, rating text ("False"), URL, title | Covers IFCN fact-checkers worldwide. Only claims someone already checked. |
| Teammate's YouTube transcripts | en, zh | — | Transcript text | Plugs in as another `source_N`. Mark as low trust unless the channel is known. |
| Web search API (Brave, Tavily, Exa) | Many | Paid key | Snippets from any site | Not needed for v1. Broader but noisier. |

Cofacts query used in the test (send it from the service worker):

```graphql
{
  ListArticles(filter: { moreLikeThis: { like: "張忠謀 告別信 黃仁勳" } }, first: 3) {
    edges {
      score
      node {
        id
        text
        articleReplies(statuses: [NORMAL]) { reply { type text reference } }
      }
    }
  }
}
```

The test used header `x-app-id: RUMORS_SITE`, which is Cofacts' own website ID. Before
the demo, ask the Cofacts team for our own app ID.

Evidence building rules:

- Take at most 3-5 sources, each cut to ~1,500 characters. Less text gives better accuracy.
- Keep `source` (publisher name) and `url` for the UI and for the trust list.
- Drop a Cofacts match if its `score` is low (threshold to tune). A weak match means
  the rumor is about something else.
- If no evidence is found, skip Jev and show "No fact-checks found". Asking Jev with
  empty evidence just returns `insufficient_evidence` anyway.

## Language handling

- Detect with `chrome.i18n.detectLanguage(text)` (should work in the service worker;
  not checked in a real browser yet). Fallback: count CJK characters with a regex.
- `zh` -> Cofacts + Google Fact Check (`languageCode=zh-TW`). `en` -> Google Fact Check
  (and Cofacts is skipped).
- Optional translation experiment: Chrome's built-in **Translator API**
  (`Translator.create({ sourceLanguage: "zh-Hant", targetLanguage: "en" })`, Chrome 138+,
  runs on-device). It is a page API, so run it in the side panel, not the service worker.
  Not checked in a real browser yet. See [01](./01-jev-integration.md#chinese-support).

## Tooling choice

| Option | Notes |
| - | - |
| **WXT 0.21** (recommended) | Vite-based, TypeScript, file-based entry points, hot reload, writes the manifest for us, built-in Vitest plugin and fake `browser` API for tests. Actively maintained. |
| CRXJS 3.0 (Vite plugin) | Lighter; you write `manifest.json` yourself. |
| Plasmo | Last release May 2025. Skip. |

UI: one small panel. Plain TypeScript or Preact is enough; React is fine if the team prefers it.

## Suggested layout (WXT)

```
entrypoints/
  background.ts        # service worker: context menu, message router, cache
  sidepanel/           # claim input + result UI
  options/             # API key inputs
lib/
  evidence/cofacts.ts  # Cofacts query + result mapping (pure)
  evidence/google.ts   # Fact Check Tools query + mapping (pure)
  jev/request.ts       # builds the claim-verification body
  jev/client.ts        # SDK wrapper (key from storage, pinned model)
  verdict.ts           # combines Jev answers + source trust into a label
  messages.ts          # typed messages + zod schemas
```

Keep `lib/` free of `chrome.*` calls so it is easy to test.

## Dev loop

- `npx wxt` opens Chromium with the extension loaded and reloads on change.
- Manual load: `chrome://extensions` -> Developer mode -> "Load unpacked" -> `.output/chrome-mv3`.
- Debug the service worker from "Inspect views: service worker" on that page.
