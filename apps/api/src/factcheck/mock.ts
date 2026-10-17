import jevRun from "./mock-jev-results.json" with { type: "json" };
import { type FactCheckFn, type FactCheckItem, type Score, SCORES } from "./provider.js";

/** The fields of a Jev screening target (`process/jev_call.ts` output) that the mock uses. */
interface JevTarget {
  readonly text: string;
  readonly start: number;
  /** Jev's 0-3 rating; `process/` flags a sentence at >= 2. */
  readonly suspicionScore: number;
}

const MAX_SCORE = SCORES[SCORES.length - 1] ?? 3;

/**
 * Jev's fractional score, floored to the contract's integer and clamped to 0-3. Flooring keeps
 * Jev's threshold: score >= 2 exactly when `process/` flagged the sentence for verification.
 */
export const toFactCheckItem = (target: JevTarget): FactCheckItem => ({
  timestamp: target.start,
  sentence: target.text,
  score: Math.min(MAX_SCORE, Math.max(0, Math.floor(target.suspicionScore))) as Score,
  sources: [], // screening only; evidence search is not built yet
});

/**
 * One item per sentence of a recorded Jev screening of the PragerU Lindzen video
 * (`results/OwqIy8Ikv-c/20261017T070618135Z/results.json`, copied here and kept identical by a test).
 */
const MOCK_ITEMS: readonly FactCheckItem[] = (jevRun.targets as readonly JevTarget[]).map(toFactCheckItem);

/** Stand-in for the real fact-check function: the same items for any transcript. */
export const mockFactCheck: FactCheckFn = async (_transcript, options = {}) => {
  options.signal?.throwIfAborted();
  return MOCK_ITEMS;
};
