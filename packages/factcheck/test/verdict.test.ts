import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../src/config.js";
import type { SourceResult, Stance, Verdict } from "../src/types.js";
import { decideLabel } from "../src/verdict.js";

const source = (stance: Stance, stanceConfidence: number, trusted: boolean): SourceResult => ({
  source: trusted ? "Science Feedback" : "Some Blog",
  title: "A",
  url: "https://example.org/a",
  text: "...",
  trusted,
  score: 0.9,
  stance,
  stanceConfidence,
});

const verdicts = (choice: Verdict, confidence: number, reversed: Verdict = choice) => ({
  verdict: { choice, confidence },
  verdictReversed: { choice: reversed, confidence },
});

const decide = (v: ReturnType<typeof verdicts>, sources: SourceResult[]) =>
  decideLabel({ ...v, sources }, DEFAULT_THRESHOLDS);

describe("decideLabel", () => {
  it("returns insufficient_evidence when there are no sources", () => {
    expect(decide(verdicts("false", 0.9), [])).toEqual({ label: "insufficient_evidence", confidence: 0 });
  });

  it("uses Jev's verdict when both orders agree with enough confidence", () => {
    expect(decide(verdicts("misleading", 0.75), [source("refutes", 0.5, false)])).toEqual({
      label: "misleading",
      confidence: 0.75,
    });
  });

  it("returns not_sure when the verdict and reversed verdict disagree", () => {
    expect(decide(verdicts("false", 0.9, "true"), [source("refutes", 0.5, false)]).label).toBe("not_sure");
  });

  it("returns not_sure when verdict confidence is low", () => {
    expect(decide(verdicts("false", 0.4), [source("refutes", 0.5, false)])).toEqual({
      label: "not_sure",
      confidence: 0.4,
    });
  });

  it("returns false when a trusted source strongly refutes, even if Jev's verdicts disagree", () => {
    const result = decide(verdicts("true", 0.3, "false"), [source("refutes", 0.92, true), source("supports", 0.9, false)]);
    expect(result).toEqual({ label: "false", confidence: 0.92 });
  });

  it("keeps misleading when a trusted source refutes and Jev says misleading", () => {
    expect(decide(verdicts("misleading", 0.8), [source("refutes", 0.85, true)]).label).toBe("misleading");
  });

  it("returns true when a trusted source strongly supports and none refutes", () => {
    expect(decide(verdicts("insufficient_evidence", 0.5), [source("supports", 0.88, true)])).toEqual({
      label: "true",
      confidence: 0.88,
    });
  });

  it("returns not_sure when trusted sources conflict", () => {
    const result = decide(verdicts("false", 0.9), [source("refutes", 0.9, true), source("supports", 0.9, true)]);
    expect(result.label).toBe("not_sure");
  });

  it("ignores a trusted stance below the threshold", () => {
    expect(decide(verdicts("true", 0.7), [source("refutes", 0.79, true)]).label).toBe("true");
  });
});
