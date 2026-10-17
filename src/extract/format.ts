import type { TranscriptSegment } from "./transcript.js";

/** Shown for a segment with no known duration (e.g. the last Gemini segment). */
const DEFAULT_DURATION = 3;

function timestamp(seconds: number, sep: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

function cues(segments: TranscriptSegment[], sep: "," | ".") {
  return segments.map((seg, i) => {
    const next = segments[i + 1];
    let end = seg.start + (seg.duration > 0 ? seg.duration : DEFAULT_DURATION);
    // Captions often overlap slightly; clamp so cues never overlap.
    if (next && end > next.start) end = Math.max(seg.start, next.start);
    return { start: timestamp(seg.start, sep), end: timestamp(end, sep), text: seg.text };
  });
}

export function toSrt(segments: TranscriptSegment[]): string {
  return (
    cues(segments, ",")
      .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`)
      .join("\n")
  );
}

export function toVtt(segments: TranscriptSegment[]): string {
  const body = cues(segments, ".")
    .map((c) => `${c.start} --> ${c.end}\n${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
