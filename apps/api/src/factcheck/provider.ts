/**
 * Contract for the fact-check function (owned by another teammate). Given the transcript from the
 * transcript function, it returns the items the extension shows. Until it ships, the API uses
 * `mockFactCheck`.
 */
import type { VideoTranscript } from "../transcripts/index.js";

export const SCORES = [0, 1, 2, 3] as const;

/** 0-3; the fact-check function defines what each value means. */
export type Score = (typeof SCORES)[number];

/** One item of the API response. The response body is `FactCheckItem[]`. */
export interface FactCheckItem {
  /** Seconds from the video start. */
  readonly timestamp: number;
  readonly sentence: string;
  readonly score: Score;
  /** Source URLs, best first. */
  readonly sources: readonly string[];
}

export interface FactCheckFnOptions {
  /** Aborted when the client leaves or the request times out (55 s). */
  readonly signal?: AbortSignal | undefined;
}

export type FactCheckFn = (transcript: VideoTranscript, options?: FactCheckFnOptions) => Promise<readonly FactCheckItem[]>;

const MAX_ITEMS = 1000;
const MAX_SENTENCE = 2000;
const MAX_SOURCES = 20;
const MAX_URL = 2048;

const isScore = (value: unknown): value is Score => SCORES.includes(value as Score);

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > MAX_URL) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

function parseItem(value: unknown, index: number): FactCheckItem {
  const bad = (field: string) => new Error(`Fact-check item ${index}: invalid ${field}`);
  if (typeof value !== "object" || value === null) throw bad("item");
  const { timestamp, sentence, score, sources } = value as Record<string, unknown>;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) throw bad("timestamp");
  if (typeof sentence !== "string" || sentence.length > MAX_SENTENCE) throw bad("sentence");
  if (!isScore(score)) throw bad("score");
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES || !sources.every(isHttpUrl)) throw bad("sources");
  return { timestamp, sentence, score, sources: [...sources] };
}

/**
 * Validate what the fact-check function returned before it goes to clients: the extension renders
 * these, so URLs must be http(s) and only the contract fields pass through.
 */
export function parseFactCheckItems(value: unknown): FactCheckItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error("The fact-check function must return an array");
  return value.map(parseItem);
}
