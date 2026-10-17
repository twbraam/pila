/** Original screening suspicion rating on a 0–5 scale; report only scores > 3. */
export type OverlayScore = number;

/** One server result for Overlay. Timestamp is seconds from the video's start. */
export interface OverlayResult {
  timestamp: number;
  sentence: string;
  score: OverlayScore;
  explanation: string;
  sources: string[];
}

/** Complete server -> Overlay response, in nondecreasing timestamp order. */
export type OverlayResults = OverlayResult[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value) || !/^https?:\/\//.test(value)) return false;
  try {
    const url = new URL(value);
    return url.hostname !== '';
  } catch {
    return false;
  }
}

/** Validate JSON at the server/Overlay boundary, including chronological order. */
export function assertOverlayResults(value: unknown): asserts value is OverlayResults {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected a top-level array of Overlay results.');
  }

  let previousTimestamp = -Infinity;
  for (const [index, result] of value.entries()) {
    if (
      !isRecord(result) ||
      Object.keys(result).length !== 5 ||
      !Object.keys(result).every(key => ['timestamp', 'sentence', 'score', 'explanation', 'sources'].includes(key)) ||
      typeof result.timestamp !== 'number' || !Number.isFinite(result.timestamp) || result.timestamp < 0 ||
      typeof result.sentence !== 'string' || result.sentence.trim() === '' ||
      typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score <= 3 || result.score > 5 ||
      typeof result.explanation !== 'string' || result.explanation.trim() === '' ||
      !Array.isArray(result.sources) || result.sources.length === 0 || !result.sources.every(isSourceUrl)
    ) {
      throw new TypeError(`Invalid Overlay result at index ${index}.`);
    }
    if (result.timestamp < previousTimestamp) {
      throw new TypeError('Overlay results must be in nondecreasing timestamp order.');
    }
    previousTimestamp = result.timestamp;
  }
}
