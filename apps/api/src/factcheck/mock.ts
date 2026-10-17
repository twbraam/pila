import chineseRun from "./mock-results/7wFWgopJP5Q.json" with { type: "json" };
import englishRun from "./mock-results/OwqIy8Ikv-c.json" with { type: "json" };
import { type FactCheckFn, type FactCheckItem, type Score, SCORES } from "./provider.js";

/** The fields of a Jev screening target (`process/jev_call.ts` output) that the mock uses. */
interface JevTarget {
  readonly text: string;
  readonly start: number;
  /** Jev's 0-3 rating; `process/` flags a sentence at >= 2. */
  readonly suspicionScore: number;
}

const MAX_SCORE = SCORES[SCORES.length - 1] ?? 3;

/** YouTube captions carry a few HTML entities (`&quot;`); Overlay renders plain text. */
const ENTITIES: Readonly<Record<string, string>> = { "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const decodeEntities = (text: string) => text.replace(/&(?:quot|#39|lt|gt|amp);/g, (e) => ENTITIES[e] ?? e);

/**
 * Jev's fractional score, floored to the contract's integer and clamped to 0-3. Flooring keeps
 * Jev's threshold: score >= 2 exactly when `process/` flagged the sentence for verification.
 */
export const toFactCheckItem = (target: JevTarget): FactCheckItem => ({
  timestamp: target.start,
  sentence: decodeEntities(target.text).trim(),
  score: Math.min(MAX_SCORE, Math.max(0, Math.floor(target.suspicionScore))) as Score,
  sources: [], // screening only; evidence search is not built yet
});

const toItems = (run: { readonly targets: readonly JevTarget[] }): readonly FactCheckItem[] => run.targets.map(toFactCheckItem);

/**
 * Recorded Jev screenings under `results/<videoId>/`, copied to `mock-results/` and kept identical
 * by a test: the PragerU Lindzen video (English) and a Taiwanese anti-nuclear talk (Chinese).
 */
const MOCK_ITEMS_BY_VIDEO: ReadonlyMap<string, readonly FactCheckItem[]> = new Map([
  ["OwqIy8Ikv-c", toItems(englishRun)],
  ["7wFWgopJP5Q", toItems(chineseRun)],
]);

const FALLBACK_VIDEO_ID = "OwqIy8Ikv-c";

/** Stand-in for the real fact-check function: the recorded run for this video, else the English one. */
export const mockFactCheck: FactCheckFn = async (transcript, options = {}) => {
  options.signal?.throwIfAborted();
  return MOCK_ITEMS_BY_VIDEO.get(transcript.videoId) ?? MOCK_ITEMS_BY_VIDEO.get(FALLBACK_VIDEO_ID) ?? [];
};
