# Risks and open questions

## Security (PoC level)

| Risk | Impact | Mitigation |
| - | - | - |
| API key in the extension | Anyone with the built extension could read a key packed inside it | Never put a key in the code or build. Each person pastes their own in the options page (`chrome.storage.local`). Don't publish the extension. |
| Prompt injection in evidence | A fact-check page, transcript, or post could contain text that steers Jev | Evidence goes only in `state`. Questions are fixed in code. Add injection cases to the eval set. |
| Forged messages | Other pages could try to talk to the extension | Validate every message with a schema. No content script in v1, which shrinks this risk. |
| Rendering evidence | XSS (injected scripts) in the side panel | Show evidence as plain text only. Links: allow only `https:` URLs. |

## Privacy

- The selected claim is sent to TypeSafe, Cofacts, and Google. Fine for a demo; say so
  in the options page.
- The extension never reads pages by itself. It only sees text the user selects.

## Product risk

- **No evidence = no verdict.** New, local, or niche claims often have no fact-check.
  The PoC should say "No fact-checks found", not guess.
- **Wrong match.** A search can return a fact-check about a similar but different
  claim. The per-source stance (`not_relevant`) and the Cofacts match score both help.
- **False labels hurt.** Show the sources and their stances next to the label so users
  can check.
- **Chinese accuracy is unknown** until we run the eval set.
- **Model updates** change answers. Pin `jev-1.13.0` for the hackathon.

## Cost and limits

- Jev: well under $0.001 per check. Not a concern.
- One TypeSafe org rate limit is shared by every teammate on that org. Cache results per
  claim in `chrome.storage.session`.

## Open questions

1. **Cofacts app ID**: ask the Cofacts team for one before the demo (we tested with
   their website's ID).
2. **Google Fact Check key**: does each person create their own Google Cloud key, or
   do we skip Google and use Cofacts only (Chinese only)? English needs Google or
   another source.
3. **Interface with the YouTube transcript work**: agree on the shared evidence shape
   `{ source, url, text }` and the trust level for video sources.
4. **Final label set**: keep Jev's four (`true`, `false`, `misleading`,
   `insufficient_evidence`) plus our "Not sure"?
