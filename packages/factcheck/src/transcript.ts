import * as z from "zod/mini";
import { InvalidInputError } from "./errors.js";
import type { Language, Sentence, TranscriptSegment } from "./types.js";

const CJK = /[㐀-鿿豈-﫿]/;
const SENTENCE_END = /[.?!;:。？！；：…]["'”’」』)）\]]*$/;
const CAPTION_CUE = /\[[^\]]*\]/g;
const MAX_SENTENCE_CHARS: Record<Language, number> = { en: 400, zh: 150 };
const MAX_CODE_POINT = 0x10ffff;
/** A Latin word, so stray "OK" or "2024" lines don't count as English. */
const ENGLISH_WORD = /[A-Za-z]{3,}/;
/** Share of segments that need English text for a bilingual transcript to be read as English. */
const ENGLISH_SHARE = 0.5;

const ENTITIES: Record<string, string> = { "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">" };

const segmentSchema = z.object({
  text: z.string(),
  start: z.number().check(z.nonnegative()),
  duration: z.number().check(z.nonnegative()),
});
const transcriptSchema = z.array(segmentSchema).check(z.minLength(1, "transcript has no segments"));

/** Validate untrusted transcript input. */
export function parseTranscript(input: unknown): TranscriptSegment[] {
  const result = transcriptSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidInputError(`Invalid transcript: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&(quot|#39|apos|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d+);/g, (entity, code: string) =>
      Number(code) <= MAX_CODE_POINT ? String.fromCodePoint(Number(code)) : entity,
    )
    .replace(/&amp;/g, "&");

const cleanLine = (line: string): string =>
  decodeEntities(line).replace(CAPTION_CUE, " ").replace(/\s+/g, " ").trim();

interface Lines {
  readonly en: readonly string[];
  readonly zh: readonly string[];
}

function splitLines(text: string): Lines {
  const lines = text.split("\n").map(cleanLine).filter(Boolean);
  return { en: lines.filter((l) => !CJK.test(l)), zh: lines.filter((l) => CJK.test(l)) };
}

/**
 * Chinese when segments with Chinese text exist and fewer than half the segments have English
 * words. Bilingual transcripts are read as English (English first).
 */
export function detectLanguage(segments: readonly TranscriptSegment[]): Language {
  const all = segments.map((s) => splitLines(s.text)).filter((l) => l.en.length + l.zh.length > 0);
  if (!all.some((l) => l.zh.length > 0)) return "en";
  const english = all.filter((l) => l.en.some((line) => ENGLISH_WORD.test(line))).length;
  return english / all.length >= ENGLISH_SHARE ? "en" : "zh";
}

interface Piece {
  readonly start: number;
  readonly text: string;
  readonly endsSentence: boolean;
}

function toPiece(segment: TranscriptSegment, language: Language, maxChars: number): Piece {
  const lines = splitLines(segment.text);
  const other: Language = language === "en" ? "zh" : "en";
  const own = lines[language].join(" ").slice(0, maxChars);
  // Bilingual captions often punctuate only one language, so either one can end a sentence.
  const endsSentence = SENTENCE_END.test(own) || SENTENCE_END.test(lines[other].join(" "));
  return { start: segment.start, text: own, endsSentence };
}

/**
 * Merge caption segments into sentences in the given language.
 * A sentence starts at its first segment's `start`. Text without punctuation is split by length.
 */
export function toSentences(segments: readonly TranscriptSegment[], language: Language): Sentence[] {
  const maxChars = MAX_SENTENCE_CHARS[language];
  const sentences: Array<Omit<Sentence, "index">> = [];
  let buffer: Piece[] = [];

  const flush = () => {
    const first = buffer[0];
    if (first) sentences.push({ start: first.start, text: buffer.map((p) => p.text).join(" ") });
    buffer = [];
  };
  const bufferLength = () => buffer.reduce((sum, p) => sum + p.text.length + 1, 0);

  for (const piece of segments.map((s) => toPiece(s, language, maxChars))) {
    if (piece.text) {
      if (bufferLength() + piece.text.length > maxChars) flush();
      buffer = [...buffer, piece];
    }
    if (piece.endsSentence) flush();
  }
  flush();

  return sentences.map((s, index) => ({ index, ...s }));
}
