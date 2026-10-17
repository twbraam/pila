/** A caption-derived sentence unit. Timings are seconds, with an exclusive end. */
export interface TranscriptSentence {
  id: string;
  text: string;
  start: number;
  end: number;
}

/** The internal Extract -> Process handoff for one video. */
export interface Transcript {
  videoId: string;
  sentences: TranscriptSentence[];
}

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Validate parsed JSON, including constraints JSON Schema cannot express. */
export function assertTranscript(value: unknown): asserts value is Transcript {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['videoId', 'sentences']) ||
    typeof value.videoId !== 'string' ||
    !VIDEO_ID_PATTERN.test(value.videoId) ||
    !Array.isArray(value.sentences)
  ) {
    throw new TypeError('Expected a Transcript with a YouTube videoId and sentences array.');
  }

  const ids = new Set<string>();
  let previousStart = -Infinity;
  for (const [index, sentence] of value.sentences.entries()) {
    if (
      !isRecord(sentence) ||
      !hasOnlyKeys(sentence, ['id', 'text', 'start', 'end']) ||
      typeof sentence.id !== 'string' ||
      sentence.id.trim() === '' ||
      typeof sentence.text !== 'string' ||
      sentence.text.trim() === '' ||
      typeof sentence.start !== 'number' ||
      typeof sentence.end !== 'number' ||
      !Number.isFinite(sentence.start) ||
      !Number.isFinite(sentence.end) ||
      sentence.start < 0 ||
      sentence.end <= sentence.start
    ) {
      throw new TypeError(`Invalid transcript sentence at index ${index}.`);
    }
    if (ids.has(sentence.id)) {
      throw new TypeError(`Duplicate sentence ID: ${sentence.id}.`);
    }
    if (sentence.start < previousStart) {
      throw new TypeError('Transcript sentences must be in nondecreasing start order.');
    }
    ids.add(sentence.id);
    previousStart = sentence.start;
  }
}
