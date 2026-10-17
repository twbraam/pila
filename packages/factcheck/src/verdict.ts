import type { Thresholds } from "./config.js";
import type { Label, SourceResult, Stance, Verdict } from "./types.js";

interface ChoiceAnswer {
  readonly choice: Verdict;
  readonly confidence: number;
}

export interface VerdictInput {
  readonly verdict: ChoiceAnswer;
  /** The same question with options in reverse order, to catch option-order bias. */
  readonly verdictReversed: ChoiceAnswer;
  readonly sources: readonly SourceResult[];
}

export interface Decision {
  readonly label: Label;
  readonly confidence: number;
}

const strongTrusted = (sources: readonly SourceResult[], stance: Stance, min: number) =>
  sources.filter((s) => s.trusted && s.stance === stance && s.stanceConfidence >= min);

const maxConfidence = (sources: readonly SourceResult[]) => Math.max(...sources.map((s) => s.stanceConfidence));

/**
 * Turn Jev's answers into a final label. Trusted fact-checkers win over Jev's overall verdict;
 * otherwise Jev's verdict stands only if both option orders agree with enough confidence.
 */
export function decideLabel(input: VerdictInput, thresholds: Thresholds): Decision {
  const { verdict, verdictReversed, sources } = input;
  if (sources.length === 0) return { label: "insufficient_evidence", confidence: 0 };

  const refutes = strongTrusted(sources, "refutes", thresholds.trustedStance);
  const supports = strongTrusted(sources, "supports", thresholds.trustedStance);

  if (refutes.length > 0 && supports.length > 0) return { label: "not_sure", confidence: verdict.confidence };
  if (refutes.length > 0) {
    const label = verdict.choice === "misleading" ? "misleading" : "false";
    return { label, confidence: maxConfidence(refutes) };
  }
  if (supports.length > 0) {
    const label = verdict.choice === "misleading" ? "misleading" : "true";
    return { label, confidence: maxConfidence(supports) };
  }

  const agrees = verdict.choice === verdictReversed.choice;
  if (!agrees || verdict.confidence < thresholds.minVerdictConfidence) {
    return { label: "not_sure", confidence: verdict.confidence };
  }
  return { label: verdict.choice, confidence: verdict.confidence };
}
