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

Jev has **no built-in world knowledge or web access**. It can't say "this is false" from
the claim alone. It can say, fast and reliably, what a given piece of evidence says about
the claim. That is why the library pairs it with Tavily.

We use Jev twice per video:

1. **Claim detection**: which transcript sentences are checkable claims.
2. **Claim verification**: for each claim, what the evidence says.

## API

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

- Models: `jev-latest` (now `jev-1.13.0`), `jev-preview` (now `jev-1.14.0`).
  Aliases move when a new model ships, so the library pins a version ID by default.
  Every response says which version answered (`model` field). Put it in the report.
- Context: 64k tokens per request, 32k per question (state + one question).
  A 5-minute transcript is ~2k tokens, so a 30-minute video still fits in one
  detection request. Longer videos: split into chunks.
- No limit on the number of questions, only on total tokens.
- Body limit 32 MiB. Errors: 400, 401, 413, 415, 422, 429 (rate limit), 529 (overloaded).
  Retry 429/529 with backoff and honor `retry-after`. The SDK does this.
- Rate limits are per organization: https://console.typesafe.ai/rate-limits.
- Price: $0.042 per million input tokens; output tokens are free.
- Data: TypeSafe does not train on requests. Zero data retention is enterprise-only.

## JS SDK: `@typesafe-ai/sdk` (v0.7.0, 2026-10-14)

- Zero runtime dependencies. ESM + CJS + TypeScript types. Answer types are inferred
  from the questions. Helpers: `noul()`, `choice()`, `score()`.
- Default timeout 10 s per attempt; built-in retry on 429/529. Accepts a custom `fetch`
  (handy for tests) and an `AbortSignal` per call.
- **Works in an MV3 service worker.** Checked the bundle: it throws only when
  `window`, `window.document`, and `navigator` all exist (a page). A service worker
  has no `window`, so it passes. A popup or side panel would need
  `dangerouslyAllowBrowser: true`, so the library must run in the service worker.
- zstd compression needs `node:zlib`, so it is off in the browser. Fine for our sizes.

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
const client = new TypeSafeClient({ apiKey, defaultModel: "jev-1.13.0" });
```

## Request 1: claim detection

Full body built from `ref/transcript.json`:
[examples/claim-detection.request.json](./examples/claim-detection.request.json).

```json
{
  "model": "jev-1.13.0",
  "state": {
    "sentences": [
      "I’m an atmospheric physicist.",
      "For 30 years I taught at MIT, during which time the climate has changed remarkably little."
    ]
  },
  "questions": {
    "checkable_0": {
      "type": "noul",
      "instructions": "Is `sentences[0]` a specific factual claim that could be checked against outside sources?",
      "criteria": {
        "true": "States a checkable fact: a number, an event, a quote, a scientific finding, or a cause and effect",
        "false": "An opinion, a prediction, a question, an introduction, or too vague to check"
      }
    }
  }
}
```

- Two `noul`s per sentence, all in one request (TypeSafe's
  [speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md) pattern): `checkable_i`
  (above) and `suspicious_i` ("Does `sentences[i]` state something that contradicts established
  scientific or historical consensus?").
- Code keeps sentences with `checkable` >= 0.5 and takes the top K (default 5) by `suspicious`.
  Live on the Lindzen video this put the reviewed false claims first. 40 sentences cost 7.3k input
  tokens; a 150-sentence batch is about 27k, inside the 64k per-request limit.
- Only the sentence text goes in the state; start times stay in code. Long transcripts are
  split into requests of 150 sentences.
- Known gap: sentences that only make sense in context ("This is the group I belong to")
  can't be searched. Jev can't rewrite them. For v1, drop them. Option for later: an extra
  `noul` "Can this be understood without the rest of the video?"

## Request 2: claim verification

Full body with real Tavily evidence for a claim from the video:
[examples/youtube-claim-verification.request.json](./examples/youtube-claim-verification.request.json).
Same shape as the team's reference payload `ref/jev-api-payload.json`.

```ts
// state
{ claim: string; evidence: Record<`source_${number}`, { source: string; url: string; text: string }> }
// questions
verdict           // choice: false | misleading | true | insufficient_evidence
verdict_reversed  // same question, options in reverse order (bias check)
source_N_stance   // choice per source: refutes | supports | not_relevant
```

Why `verdict_reversed`: Jev can lean toward the first option. If the two verdicts
disagree, the claim is "Not sure". Same request, so no extra latency.

Changes from `ref/jev-api-payload.json` (also applied in `examples/claim-verification.request.json`):

| Change | Why |
| - | - |
| Removed site boilerplate from evidence | Jev gets less accurate with unrelated text in the state. Tavily snippets are already clean. |
| Added `verdict_reversed` | Catches option-order bias. |
| Referenced fields by name in backticks (`` `evidence.source_1` ``) | TypeSafe docs recommend pointing questions at named parts of the state. |
| Pinned `jev-1.13.0` | So answers don't change when the alias moves. |

Try either example (after `export TYPESAFE_API_KEY=...`):

```bash
curl https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @docs/research/examples/youtube-claim-verification.request.json
```

## Combining the answers in code

Jev gives probabilities; our code makes the final call. Rules as built (`src/verdict.ts`):

1. No evidence left after filtering -> **insufficient_evidence** (skip the Jev call).
2. Trusted sources (domain on our list) with stance confidence >= 0.8:
   - some refute and some support -> **not_sure**
   - some refute -> **false** (or **misleading** if Jev's verdict is misleading)
   - some support -> **true** (or **misleading** if Jev's verdict is misleading)
   These win over Jev's overall verdict.
3. `verdict` and `verdict_reversed` disagree, or `verdict.confidence` < 0.6 -> **not_sure**.
4. Otherwise -> `verdict.choice`.
5. Always return each source's stance and URL, so the UI can show *why*.

Source trust is a domain list in code (fact-checkers > science bodies and major news >
everything else). Jev should not decide how much to trust a source. Thresholds are
config values, tuned on the eval set ([05](./05-testing.md)).

## Chinese support

- Jev's docs: English is strongest; Chinese works but is less accurate. We must measure it.
- `ref/transcript.json` has two lines per segment: Simplified Chinese, then English.
  English mode uses the English line; Chinese mode uses the Chinese line.
- Evidence may come back in English even for a Chinese query (seen in testing), so
  Chinese mode will often send a mixed-language state.
- Keep `instructions` and `criteria` in English in every mode. Only `state` changes
  language, so results are comparable.
- Eval plan: run the same claims in English mode and Chinese mode and compare accuracy.

## Known Jev weak spots (from the jev-1.13 jaggedness page)

- Reads instructions literally. Spell out the exact condition and boundary cases.
- Bad at math, counting, and comparing dates. Do that in code.
- Accuracy drops with long state full of unrelated text. Keep evidence short and on topic.
- Text written to steer the model can move the answer (prompt injection). Both the
  transcript and the web evidence are untrusted.
- Choice option order can bias the answer (hence `verdict_reversed`).
- Cannot generate text, so it can't write an explanation. The explanation comes from
  the per-source stances and their links.
