import type { Evidence, Sentence } from "./types.js";

/** Shorter sentences can match ordinary text by chance. */
const MIN_SENTENCE_CHARS = 40;
/** Fact-checks quote a claim or two; a page with this many transcript sentences is a reprint. */
const MIN_COPIED_SENTENCES = 3;

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type CopyFilter = (evidence: readonly Evidence[]) => Evidence[];

/**
 * Build a filter that drops evidence reprinting the video's own transcript (the channel's PDF,
 * reposts, transcript pages). Such pages repeat the claims, so Jev would read them as support.
 * Build it once per video; it normalizes the transcript up front.
 */
export function transcriptCopyFilter(sentences: readonly Sentence[]): CopyFilter {
  const needles = sentences.map((s) => normalize(s.text)).filter((s) => s.length >= MIN_SENTENCE_CHARS);
  return (evidence) =>
    evidence.filter((e) => {
      const text = normalize(e.text);
      return needles.filter((n) => text.includes(n)).length < MIN_COPIED_SENTENCES;
    });
}

export const dropTranscriptCopies = (evidence: readonly Evidence[], sentences: readonly Sentence[]): Evidence[] =>
  transcriptCopyFilter(sentences)(evidence);
