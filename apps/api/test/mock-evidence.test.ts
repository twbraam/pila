import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildEvidenceSources, type EvidenceRun, type TavilyResponse } from "../src/factcheck/mock-evidence.js";
import { loadEvidenceRun, MOCK_EVIDENCE_RUNS } from "../scripts/mock-evidence.js";

const run = (assessments: EvidenceRun["assessments"], groups: EvidenceRun["groups"]): EvidenceRun => ({ videoId: "v", groups, assessments });
const tavily = (...results: [string, number][]): TavilyResponse => ({ results: results.map(([url, score]) => ({ url, score })) });

describe("buildEvidenceSources", () => {
  it("prefers Jev's citations", () => {
    const evidence = run([{ targetId: "s1", citations: [{ url: "https://cited.org/a" }] }], [{ id: "g1", targetIds: ["s1"] }]);
    expect(buildEvidenceSources(evidence, { g1: tavily(["https://search.org/x", 0.9]) })).toEqual({ s1: ["https://cited.org/a"] });
  });

  it("falls back to the Tavily results of the target's search, best first, deduped, http(s) only", () => {
    const evidence = run([], [{ id: "g1", targetIds: ["s1", "s2"] }]);
    const results = tavily(["https://b.org", 0.2], ["https://a.org", 0.9], ["https://b.org", 0.1], ["javascript:x", 1]);
    expect(buildEvidenceSources(evidence, { g1: results })).toEqual({ s1: ["https://a.org", "https://b.org"], s2: ["https://a.org", "https://b.org"] });
  });

  it("leaves out targets with neither citations nor search results", () => {
    expect(buildEvidenceSources(run([{ targetId: "s1", citations: [] }], [{ id: "g1", targetIds: ["s1"] }]), {})).toEqual({});
  });
});

describe("committed mock evidence", () => {
  it.each(Object.keys(MOCK_EVIDENCE_RUNS))("matches the evidence run in results/ for %s", (videoId) => {
    const committed = JSON.parse(readFileSync(new URL(`../src/factcheck/mock-results/${videoId}.evidence.json`, import.meta.url), "utf8"));
    expect(committed).toEqual(loadEvidenceRun(videoId));
  });
});
