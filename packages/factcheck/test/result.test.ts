import { describe, expect, it } from "vitest";
import type { SubtitleSentence } from "../src/contract.js";
import { toFactCheckResult } from "../src/result.js";
import type { ClaimResult, Label, SourceResult, Stance } from "../src/types.js";

const ref: SubtitleSentence = { id: "s7", text: "CO2 is not the dominant factor.", startSeconds: 107.8, endSeconds: 111.8 };

const source = (stance: Stance, overrides: Partial<SourceResult> = {}): SourceResult => ({
  source: "Science Feedback",
  title: "Video from PragerU makes several incorrect claims - Science Feedback",
  url: "https://science.feedback.org/review/x",
  text: "Lindzen claims there is no evidence. This is false.",
  trusted: true,
  score: 0.9,
  stance,
  stanceConfidence: 0.9,
  quote: "This is false.",
  ...overrides,
});

const claimResult = (label: Label, sources: SourceResult[], extra: Partial<ClaimResult> = {}): ClaimResult => ({
  claim: { index: 7, start: 107.8, text: "CO2 is not the dominant factor.", checkable: 0.9, suspicious: 0.8 },
  label,
  confidence: 0.93,
  sources,
  ...extra,
});

const context = { videoId: "OwqIy8Ikv-c", language: "en" as const, misleadingAs: "unknown" as const };

describe("toFactCheckResult", () => {
  it("maps a false claim to misinformation with the refuting sources and a quoted explanation", () => {
    const result = toFactCheckResult(
      claimResult("false", [source("not_relevant", { url: "https://a.org/x", source: "A" }), source("refutes")]),
      ref,
      context,
    );
    expect(result).toEqual({
      videoId: "OwqIy8Ikv-c",
      sentenceId: "s7",
      startSeconds: 107.8,
      endSeconds: 111.8,
      sentence: "CO2 is not the dominant factor.",
      verdict: "misinformation",
      confidence: 0.93,
      explanation: "Science Feedback says this claim is false: “This is false.”",
      sources: [{ title: "Video from PragerU makes several incorrect claims - Science Feedback", url: "https://science.feedback.org/review/x" }],
    });
  });

  it("maps a true claim to verified with the supporting sources", () => {
    const result = toFactCheckResult(claimResult("true", [source("supports", { quote: "Warming is about 1 °C." })]), ref, context);
    expect(result.verdict).toBe("verified");
    expect(result.explanation).toBe("Science Feedback supports this claim: “Warming is about 1 °C.”");
    expect(result.sources).toHaveLength(1);
  });

  it("maps misleading to unknown by default, or to misinformation when configured", () => {
    const misleading = claimResult("misleading", [source("refutes")]);
    expect(toFactCheckResult(misleading, ref, context).verdict).toBe("unknown");
    expect(toFactCheckResult(misleading, ref, { ...context, misleadingAs: "misinformation" }).verdict).toBe("misinformation");
    expect(toFactCheckResult(misleading, ref, context).explanation).toBe("Science Feedback says this claim is misleading: “This is false.”");
  });

  it("never reports misinformation or verified without a source that backs it", () => {
    const unbacked = toFactCheckResult(claimResult("false", [source("not_relevant")]), ref, context);
    expect(unbacked).toMatchObject({
      verdict: "unknown",
      confidence: 0,
      sources: [],
      explanation: "The sources found don't clearly confirm or refute this claim.",
    });
    expect(toFactCheckResult(claimResult("true", [source("refutes")]), ref, context).verdict).toBe("unknown");
  });

  it("explains missing evidence", () => {
    const result = toFactCheckResult(claimResult("insufficient_evidence", [], { confidence: 0 }), ref, context);
    expect(result).toMatchObject({ verdict: "unknown", sources: [], explanation: "No reliable source addressing this claim was found." });
  });

  it("explains unclear evidence and lists only relevant sources", () => {
    const result = toFactCheckResult(
      claimResult("not_sure", [source("supports", { url: "https://b.org/y" }), source("not_relevant")]),
      ref,
      context,
    );
    expect(result.explanation).toBe("The sources found don't clearly confirm or refute this claim.");
    expect(result.sources.map((s) => s.url)).toEqual(["https://b.org/y"]);
  });

  it("explains a failed check", () => {
    const failed = claimResult("not_sure", [], { error: { name: "UpstreamError", message: "Jev request failed with HTTP 500" } });
    expect(toFactCheckResult(failed, ref, context).explanation).toBe("This claim could not be checked.");
  });

  it("falls back to the start of the source text when there is no quote", () => {
    const result = toFactCheckResult(claimResult("false", [source("refutes", { quote: undefined })]), ref, context);
    expect(result.explanation).toBe("Science Feedback says this claim is false: “Lindzen claims there is no evidence.”");
  });

  it("writes Chinese explanations for Chinese videos", () => {
    const zh = { ...context, language: "zh" as const };
    expect(toFactCheckResult(claimResult("false", [source("refutes")]), ref, zh).explanation).toBe(
      "Science Feedback 指出此說法錯誤：「This is false.」",
    );
    expect(toFactCheckResult(claimResult("insufficient_evidence", []), ref, zh).explanation).toBe("找不到查核此說法的可靠來源。");
    expect(toFactCheckResult(claimResult("misleading", [source("refutes")]), ref, zh).explanation).toBe(
      "Science Feedback 指出此說法有誤導之嫌：「This is false.」",
    );
    expect(toFactCheckResult(claimResult("true", [source("supports")]), ref, zh).explanation).toBe(
      "Science Feedback 支持此說法：「This is false.」",
    );
    expect(toFactCheckResult(claimResult("not_sure", []), ref, zh).explanation).toBe("找到的來源無法明確證實或推翻此說法。");
    expect(toFactCheckResult(claimResult("not_sure", [], { error: { name: "x", message: "y" } }), ref, zh).explanation).toBe(
      "此說法查核失敗。",
    );
  });

  it("leaves out the quote when the source has no usable text", () => {
    const result = toFactCheckResult(claimResult("false", [source("refutes", { quote: undefined, text: "" })]), ref, context);
    expect(result.explanation).toBe("Science Feedback says this claim is false.");
    const zh = toFactCheckResult(claimResult("false", [source("refutes", { quote: undefined, text: "" })]), ref, { ...context, language: "zh" });
    expect(zh.explanation).toBe("Science Feedback 指出此說法錯誤。");
  });

  it("uses the publisher name as the title when the page has none", () => {
    const result = toFactCheckResult(claimResult("false", [source("refutes", { title: "" })]), ref, context);
    expect(result.sources[0]?.title).toBe("Science Feedback");
  });
});
