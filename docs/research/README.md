# Research: YouTube fact-check library (Jev + Tavily)

Status: research spike, updated 2026-10-17. Nothing is built yet.

## Goal

A TypeScript library that takes a YouTube video's transcript, finds the checkable
claims, searches the web for evidence with Tavily, and asks TypeSafe's Jev model whether
each claim is true, false, misleading, or not provable.

The Chrome extension team imports this library and runs it in the extension's service
worker (its background script). This repo owns the library, not the extension UI.

## Scope (decided)

| Topic | Decision |
| - | - |
| Stage | Hackathon PoC. No backend, no store release. |
| Input | A YouTube video: transcript segments `{ text, start, duration }` plus title and channel if known. Not general web pages. |
| Output | A report: one verdict per claim, with timestamp, confidence, and sources. |
| Our deliverable | TypeScript library that calls Jev and Tavily. Must run in a Chrome MV3 service worker and in Node 22+. |
| Extension team | UI, getting the transcript from YouTube, storing keys. See [04](./04-chrome-extension-integration.md). |
| API keys | Each person uses their own Jev and Tavily keys, passed into the library. |
| Languages | English first, then Chinese. |

## Read in this order

1. [01-jev-integration.md](./01-jev-integration.md): what Jev can do, the API, the requests we send
2. [02-tavily-evidence-search.md](./02-tavily-evidence-search.md): finding evidence with Tavily
3. [03-library-design.md](./03-library-design.md): pipeline, public API, runtime rules, layout
4. [04-chrome-extension-integration.md](./04-chrome-extension-integration.md): how the extension team uses the library
5. [05-testing.md](./05-testing.md): unit, contract, eval, and service-worker tests
6. [06-risks-and-open-questions.md](./06-risks-and-open-questions.md)

Examples (`examples/`):

| File | What it is |
| - | - |
| `claim-detection.request.json` | Jev request built from `ref/transcript.json`: 40 sentences, one "is this checkable?" question each |
| `youtube-claim-verification.request.json` | Jev request for one claim from the video, with real Tavily evidence |
| `claim-verification.request.json` | The team's Morris Chang reference payload, cleaned up |
| `tavily-search.response.json` | Real Tavily response used above (test fixture) |

## TL;DR

- **Jev judges; it does not know facts.** It answers typed questions about the text we
  send. Tavily brings the evidence; Jev decides what the evidence says about the claim.
- **Jev can also pick the claims.** It can't write text, but it can answer "is sentence
  N a checkable claim?" for every sentence in one fast request.
- **Tavily finds good evidence if we steer it.** Tested 2026-10-17 on
  `ref/transcript.json` (Richard Lindzen's PragerU climate video). With fact-check sites
  preferred and the speaker and channel in the query, the #1 result was Science
  Feedback's review of this exact video. A plain query returned IPCC report cover pages.
  So video title and channel matter.
- **Both APIs work from an extension.** Jev and Tavily both accept requests with a
  `chrome-extension://` origin (tested). Jev's SDK `@typesafe-ai/sdk` runs in a service
  worker; Tavily's SDK `@tavily/core` depends on `axios` and `https-proxy-agent`
  (Node-only), so call Tavily with plain `fetch`.
- **Cost per 5-minute video:** ~6-12 Tavily credits (free tier: 1,000/month) and well
  under $0.01 of Jev. Expected time: ~5-10 s, mostly Tavily (~2.6 s per search).

## Pipeline

```
transcript segments + video info
-> 1. sentences: merge segments into sentences, keep start time, pick language line   (code)
-> 2. claims: one Jev request, a `noul` per sentence "is this checkable?"; keep top K  (Jev x1)
-> 3. evidence: Tavily search for the video as a whole + one per claim              (Tavily x K+1)
-> 4. verify: one Jev request per claim: verdict, verdict_reversed, stance per source (Jev x K, parallel)
-> 5. combine: rules in code -> label + confidence per claim                         (code)
-> VideoReport
```

## Sources

- Jev launch post: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev docs index: https://docs.typesafe.ai/llms.txt
- Tavily docs index: https://docs.tavily.com/llms.txt
- Tavily Search API: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Chrome extension docs: https://developer.chrome.com/docs/extensions
- Science Feedback (labeled video reviews, useful for evals): https://science.feedback.org
