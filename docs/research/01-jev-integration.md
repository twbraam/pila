# Jev integration

## What Jev is

Jev is TypeSafe's "System One" model. It does not write text. You send:

- `state`: the content to judge (string, object, or array)
- `questions`: a map of typed questions you name

It returns one typed answer per question, with calibrated probabilities. All questions
in one request are answered in parallel against the same state.

| Question type | Use it for | Answer fields |
| - | - | - |
| `noul` | yes/no | `noul` (0-1, probability of yes) |
| `choice` | pick one of up to 255 options | `choice`, `probabilities`, `confidence` |
| `score` | rate on 2-10 ordered levels | `score`, `legend`, `probabilities`, `confidence` |
| `box` | find a region in an image (preview only) | `box` |

## What this means for verification

Jev has **no built-in world knowledge or web access**. It cannot tell you "this event
did not happen" from the claim alone. It can tell you, reliably and fast, what a given
piece of evidence says about the claim. So the extension's job is:

1. Get the claim.
2. Find evidence (see [02](./02-chrome-extension.md#evidence-sources)).
3. Ask Jev for a verdict and for each source's stance.
4. Combine the answers in code.

This matches TypeSafe's own
[citation check cookbook](https://docs.typesafe.ai/cookbooks/citation_check.md).

## API

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

- Models: `jev-latest` (now `jev-1.13.0`), `jev-preview` (now `jev-1.14.0`).
  Aliases move when a new model ships, so pin a version ID once we tune thresholds.
  Every response says which version answered (`model` field). Log it.
- Context: 64k tokens per request, 32k per question (state + one question).
- Body limit 32 MiB. Errors: 400, 401, 413, 415, 422, 429 (rate limit), 529 (overloaded).
  Retry 429/529 with exponential backoff and honor `retry-after`. The SDK does this.
- Rate limits are per organization: https://console.typesafe.ai/rate-limits.
  Teammates sharing one org share one limit.
- Price: $0.042 per million input tokens; output tokens are free.
- Data: TypeSafe does not train on requests. Zero data retention is enterprise-only.

## JS SDK: `@typesafe-ai/sdk` (v0.7.0, 2026-10-14)

- Zero runtime dependencies. ESM + CJS + TypeScript types. Answer types are inferred
  from the questions. Helpers: `noul()`, `choice()`, `score()`.
- Default timeout 10 s per attempt; built-in retry on 429/529.
- **Works in an MV3 service worker.** Checked the bundle: it throws only when
  `window`, `window.document`, and `navigator` all exist (a page). A service worker
  has no `window`, so it passes. In the side panel it would need
  `dangerouslyAllowBrowser: true`, so keep all Jev calls in the service worker.
- zstd compression needs `node:zlib`, so it is off in the browser. Fine for our sizes.

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
const client = new TypeSafeClient({ apiKey, defaultModel: "jev-1.13.0" });
```

## The claim-verification request

Full working body: [examples/claim-verification.request.json](./examples/claim-verification.request.json).
It is the team's reference payload (`ref/jev-api-payload.json`) with these fixes:

| Change | Why |
| - | - |
| Fixed invalid JSON | The original had a raw line break inside `source_3.text` and three cut-off lines (the `misleading` and `insufficient_evidence` criteria and the `source_2_stance` instruction). The missing text was rewritten by guess; check the wording. |
| Removed site boilerplate from `source_3` | Menus, footer, and "Invalid search form" were in the text. Jev gets less accurate with unrelated text in the state. The garbled "Background" section was also dropped. |
| Added `verdict_reversed` | Same question, options in reverse order. Jev can lean toward the first option. If the two verdicts disagree, show "Not sure". Same request, so no extra latency. |
| Referenced fields by name in backticks (`` `evidence.source_1` ``) | TypeSafe docs recommend pointing questions at named parts of the state. |
| Pinned `jev-1.13.0` | So answers don't change when the alias moves. |

Shape the extension will build:

```ts
type VerifyRequest = {
  claim: string;
  evidence: Record<`source_${number}`, { source: string; url?: string; text: string }>;
};
// questions: verdict, verdict_reversed, and one `source_N_stance` per source
```

Try it (after `export TYPESAFE_API_KEY=...`):

```bash
curl https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @docs/research/examples/claim-verification.request.json
```

## Combining the answers in code

Jev gives probabilities; our code makes the final call. Starting rule for the PoC:

1. If `verdict` and `verdict_reversed` disagree, or `verdict.confidence` < 0.6
   -> **Not sure**.
2. If a trusted fact-checker source (Cofacts reply, Taiwan FactCheck Center, an
   IFCN-certified site from Google Fact Check) has stance `refutes` with confidence
   >= 0.8 -> **False**, even if weaker sources disagree.
3. Otherwise use `verdict`.
4. Always show each source's stance and link, so the user sees *why*.

Source trust is a fixed list in code (fact-checkers > known news sites > unknown
posts/videos). Jev should not decide how much to trust a source. Tune the thresholds on
the eval set ([03](./03-testing.md)).

## Chinese support

- Jev's docs: English is strongest; Chinese works but is less accurate. We must measure it.
- Plan: run the eval set three ways and compare:
  1. All English (claim and evidence in English).
  2. All Chinese (claim and evidence as written).
  3. Chinese translated to English on-device first (Chrome's built-in Translator API),
     then sent to Jev.
- Keep the question `instructions` and `criteria` in English in every case. Only
  `state` changes language. That keeps the questions the same across runs.
- Cofacts evidence is in Traditional Chinese, so mode 2 or 3 is needed for it.

## Known Jev weak spots (from the jev-1.13 jaggedness page)

- Reads instructions literally. Spell out the exact condition and boundary cases.
- Bad at math, counting, and comparing dates. Do that in code.
- Accuracy drops with long state full of unrelated text. Clean evidence before sending.
- Text written to steer the model can move the answer (prompt injection). Evidence is
  untrusted page text too.
- Choice option order can bias the answer (hence `verdict_reversed`).
- Cannot generate text, so it can't write an explanation. The explanation comes from
  the per-source stances and their links.
