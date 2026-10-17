import type { TranscriptSegment } from 'youtube-transcript-plus';
import { assertTranscript, type Transcript } from '../shared/transcript';
import { parseVideoId } from './video-id';

/** Assemble captions without inventing word timings or missing punctuation. */
export function normalizeCaptions(
  videoId: string,
  captions: readonly TranscriptSegment[],
  locale = captions[0]?.lang || 'en',
): Transcript {
  const id = parseVideoId(videoId);
  const ordered = captions.map((caption, index) => {
    if (
      !caption ||
      typeof caption.text !== 'string' ||
      !Number.isFinite(caption.offset) ||
      !Number.isFinite(caption.duration) ||
      caption.offset < 0 ||
      caption.duration <= 0 ||
      !Number.isFinite(caption.offset + caption.duration) ||
      caption.offset + caption.duration <= caption.offset
    ) {
      throw new TypeError(`Invalid caption text or timing at index ${index}.`);
    }
    return { ...caption, text: caption.text.replace(/\s+/gu, ' ').trim() };
  }).filter((caption) => caption.text !== '').sort((a, b) => a.offset - b.offset);

  const spans: { from: number; to: number; start: number; end: number }[] = [];
  const parts: string[] = [];
  let position = 0;
  for (const caption of ordered) {
    if (parts.length > 0) position += 1;
    spans.push({
      from: position,
      to: position + caption.text.length,
      start: caption.offset,
      end: caption.offset + caption.duration,
    });
    parts.push(caption.text);
    position += caption.text.length;
  }

  const transcript: Transcript = { videoId: id, sentences: [] };
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  let firstSpan = 0;
  for (const part of segmenter.segment(parts.join(' '))) {
    const text = part.segment.trim();
    if (!text) continue;
    const from = part.index + part.segment.length - part.segment.trimStart().length;
    const to = from + text.length;
    while (firstSpan < spans.length && spans[firstSpan]!.to <= from) firstSpan += 1;

    let start = Infinity;
    let end = -Infinity;
    for (let index = firstSpan; index < spans.length; index += 1) {
      const span = spans[index]!;
      if (span.from >= to) break;
      start = Math.min(start, span.start);
      end = Math.max(end, span.end);
    }
    transcript.sentences.push({
      id: `s${String(transcript.sentences.length + 1).padStart(4, '0')}`,
      text,
      start,
      end,
    });
  }
  assertTranscript(transcript);
  return transcript;
}
