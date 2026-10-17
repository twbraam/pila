# Research: Fake-news checker Chrome extension (Jev)

Status: research spike, updated 2026-10-17. Nothing is built yet.

## Goal

A hackathon PoC (proof of concept): a Chrome extension that takes a claim from the
current page, finds evidence, and asks TypeSafe's Jev model whether the claim is true,
false, misleading, or not provable.

## Scope (decided)

| Topic | Decision |
| - | - |
| Stage | Hackathon PoC. No backend, no store release. |
| API key | Each person pastes their own Jev key into the extension's options page. |
| Main feature | Claim verification: claim + evidence -> Jev verdict. Same shape as our reference payload. |
| Languages | English first, then Traditional Chinese (Taiwan). |
| YouTube transcripts | Owned by another teammate. Out of scope here, but the same payload shape lets their transcripts plug in as evidence. |

## Read in this order

1. [01-jev-integration.md](./01-jev-integration.md): what Jev can do, the API, the claim-verification payload
2. [02-chrome-extension.md](./02-chrome-extension.md): extension architecture, evidence sources, tooling
3. [03-testing.md](./03-testing.md): unit, integration, and E2E testing
4. [04-risks-and-open-questions.md](./04-risks-and-open-questions.md): risks and remaining decisions
5. [examples/claim-verification.request.json](./examples/claim-verification.request.json): a working request body

## TL;DR

- **Jev judges; it does not know facts.** It answers typed questions about the text we
  send. So the extension must bring the evidence. Jev then decides whether the evidence
  supports or refutes the claim.
- **Evidence sources found:**
  - **Cofacts** (Taiwan's crowd-sourced fact-check database). Open GraphQL API, no key.
    Tested 2026-10-17 with a Chinese query: it returned the Morris Chang letter
    labeled `RUMOR`, with a link to the Taiwan FactCheck Center report.
  - **Google Fact Check Tools API**: published fact-checks in many languages. Needs a
    free Google Cloud API key.
- **Calling Jev from the extension works.** `POST /v1/systemone` accepts any `Origin`
  (tested 2026-10-17). The extension's service worker (its background script) can call
  it with `host_permissions`. The JS SDK `@typesafe-ai/sdk@0.7.0` also loads there.
- **Cheap and fast.** $0.042 per million input tokens, output is free, 70-500 ms per call.
- **Recommended stack:** WXT (Vite-based extension framework) + TypeScript + Vitest + Playwright.

## PoC flow

```
User selects text on a page -> right-click "Verify with Jev"
  (or types / pastes a claim in the side panel)
-> service worker: detect language (en / zh)
-> service worker: search evidence (Cofacts, Google Fact Check) in that language
-> service worker: clean evidence, build the Jev request (claim + evidence + questions)
-> Jev returns: verdict, verdict_reversed (bias check), one stance per source
-> code combines them into a final label + confidence
-> side panel shows the label, each source's stance, and links to the sources
```

## Sources

- Jev launch post: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev docs index: https://docs.typesafe.ai/llms.txt
- Cofacts API: https://api.cofacts.tw/graphql (GraphQL; project at https://github.com/cofacts)
- Google Fact Check Tools API: https://developers.google.com/fact-check/tools/api
- Chrome extension docs: https://developer.chrome.com/docs/extensions
- Playwright extension testing: https://playwright.dev/docs/chrome-extensions
- WXT: https://wxt.dev
