# Risks and open questions

## Security (PoC level)

| Risk | Impact | Mitigation |
| - | - | - |
| API keys in the extension | Anyone with a build containing a key can use it | Keys are passed in at runtime from the options page. Never commit or bundle a key. Don't publish the extension. |
| Prompt injection | A transcript or web page can contain text that steers Jev | Transcript and evidence go only in `state`. Questions are fixed in code. Injection cases in the eval set. |
| Forged messages | YouTube pages could try to send fake messages | The extension validates messages with a schema. The library validates its own input. |
| Rendering evidence | Injected scripts in the extension UI | Plain text only; `https:` links only. |

## Product risk

- **No review, no verdict.** Most videos have never been fact-checked. Claim-level
  searches help, but many claims will end as `insufficient_evidence`. That is the
  honest answer; the UI should present it that way.
- **Wrong match.** A search can return a fact-check about a similar but different claim.
  Per-source `not_relevant` stance and the score filter help.
- **Claims that need context** ("This is the group I belong to") are dropped in v1.
- **Auto-generated captions** have no punctuation and more errors. Sentence splitting
  and claim detection will be worse. Test on at least one.
- **False labels hurt.** Always show sources and stances next to the label.
- **Chinese accuracy is unknown** until the eval runs. Evidence will often be English.
- **Model updates** change answers. Pin `jev-1.13.0` for the hackathon.

## Cost and limits

- Tavily free plan: 1,000 credits/month per key, ~80 videos (12 credits each). Development keys: 100
  requests/minute. Cache reports per video.
- Jev: well under $0.01 per video. One TypeSafe org rate limit is shared by teammates.

## Open questions

Decided 2026-10-17: npm workspaces monorepo; the extension team always passes title and
channel; default 5 claims per video.

1. **Label set**: `true`, `false`, `misleading`, `insufficient_evidence`, `not_sure`. OK?
2. **Thresholds** are untuned guesses until the Jev eval runs (needs the Jev key).
