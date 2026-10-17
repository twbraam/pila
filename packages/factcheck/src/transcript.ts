import * as z from "zod/mini";
import { HAS_CJK } from "./cjk.js";
import { InvalidInputError } from "./errors.js";
import type { Language, Sentence, TranscriptSegment } from "./types.js";

const SENTENCE_END = /[.?!;:。？！；：…]["'”’」』)）\]]*$/;
const CAPTION_CUE = /\[[^\]]*\]/g;
export const MAX_SENTENCE_CHARS: Readonly<Record<Language, number>> = { en: 400, zh: 150 };
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
  return { en: lines.filter((l) => !HAS_CJK.test(l)), zh: lines.filter((l) => HAS_CJK.test(l)) };
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
  readonly end: number;
  readonly text: string;
  readonly endsSentence: boolean;
}

/** The cleaned lines of `text` in `language`, joined; empty when there are none. */
export function pickLanguage(text: string, language: Language): string {
  return splitLines(text)[language].join(" ");
}

const roundTime = (seconds: number) => Math.round(seconds * 1000) / 1000;

function toPiece(segment: TranscriptSegment, language: Language, maxChars: number): Piece {
  const lines = splitLines(segment.text);
  const other: Language = language === "en" ? "zh" : "en";
  const own = lines[language].join(" ").slice(0, maxChars);
  // Bilingual captions often punctuate only one language, so either one can end a sentence.
  const endsSentence = SENTENCE_END.test(own) || SENTENCE_END.test(lines[other].join(" "));
  return { start: segment.start, end: roundTime(segment.start + segment.duration), text: own, endsSentence };
}

export interface TimedSentence extends Sentence {
  /** Seconds from the start of the video where the last caption of the sentence ends. */
  readonly end: number;
}

/**
 * Merge caption segments into sentences in the given language, with start and end times.
 * A sentence starts at its first segment's `start`. Text without punctuation is split by length.
 */
export function toTimedSentences(segments: readonly TranscriptSegment[], language: Language): TimedSentence[] {
  const maxChars = MAX_SENTENCE_CHARS[language];
  const sentences: Array<Omit<TimedSentence, "index">> = [];
  let buffer: Piece[] = [];

  const flush = () => {
    const first = buffer[0];
    const last = buffer.at(-1);
    if (first && last) sentences.push({ start: first.start, end: last.end, text: buffer.map((p) => p.text).join(" ") });
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

/** Like `toTimedSentences`, without end times. */
export const toSentences = (segments: readonly TranscriptSegment[], language: Language): Sentence[] =>
  toTimedSentences(segments, language).map(({ index, start, text }) => ({ index, start, text }));
