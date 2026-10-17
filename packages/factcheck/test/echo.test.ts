import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TRUSTED_DOMAINS } from "../src/config.js";
import { dropTranscriptCopies } from "../src/echo.js";
import { toEvidence } from "../src/tavily.js";
import { toSentences } from "../src/transcript.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const sentences = toSentences(read("../../../ref/transcript.json"), "en");
const options = { trustedDomains: DEFAULT_TRUSTED_DOMAINS, minScore: 0, maxSources: 10, maxChars: 1500 };

describe("dropTranscriptCopies", () => {
  it("drops a page that reprints the transcript, even on a trusted domain", () => {
    const evidence = toEvidence(read("./fixtures/tavily-ipcc-claim.json").results, options);
    const kept = dropTranscriptCopies(evidence, sentences);
    expect(evidence.some((e) => e.url.includes("climatefeedback.org/?p=11750"))).toBe(true);
    expect(kept.some((e) => e.url.includes("climatefeedback.org/?p=11750"))).toBe(false);
    expect(kept).toHaveLength(evidence.length - 1);
  });

  it("keeps fact-check reviews that quote a claim or two", () => {
    const evidence = toEvidence(read("./fixtures/tavily-lindzen.json").results, options);
    expect(dropTranscriptCopies(evidence, sentences)).toEqual(evidence);
  });

  it("ignores short sentences that could match by chance", () => {
    const short = [{ index: 0, start: 0, text: "Group one is." }, { index: 1, start: 1, text: "It is." }, { index: 2, start: 2, text: "Yes." }];
    const evidence = [{ source: "x", url: "https://x.org", text: "Group one is. It is. Yes.", trusted: false, score: 1 }];
    expect(dropTranscriptCopies(evidence, short)).toEqual(evidence);
  });
});
