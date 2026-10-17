import type { Candidate, Grounding, Source } from './gemini';

export type Notes = Map<number, { notes: string; sources: Source[] }>;

function sourceUrl(uri: string): boolean {
  if (!/^https?:\/\//.test(uri) || /\s/.test(uri)) return false;
  try { return new URL(uri).hostname !== ''; } catch { return false; }
}

/** Attach only sources actually cited for a findings line, using UTF-8 byte offsets.
 * https://ai.google.dev/api/generate-content#Segment
 */
export function parseNotes(text: string, grounding: Grounding = {}, parts?: Candidate['content']['parts']): Notes {
  const items: { id: number; notes: string; start: number; end: number; raw: string; sources: Map<string, Source> }[] = [];
  let offset = 0;
  const ids = new Set<number>();
  for (const raw of text.split('\n')) {
    const start = offset;
    offset += Buffer.byteLength(raw) + 1;
    const match = raw.match(/^\s*(\d+)\s*:\s*(.+)$/);
    if (!match) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || ids.has(id)) throw new Error('Invalid or duplicate grounding sentence ID.');
    ids.add(id);
    items.push({ id, notes: match[2]!.trim(), start, end: offset - 1, raw, sources: new Map() });
  }
  const chunks = grounding.groundingChunks ?? [];
  const supports = grounding.groundingSupports ?? [];
  if (!Array.isArray(chunks) || !Array.isArray(supports)) throw new Error('Invalid grounding metadata.');
  const bytes = Buffer.from(text);
  for (const support of supports) {
    const segment = support?.segment;
    if (!segment) continue;
    const partIndex = segment.partIndex ?? 0;
    if (!Number.isSafeInteger(partIndex) || partIndex < 0 || (!parts && partIndex !== 0)) continue;
    if (parts && (!parts[partIndex] || parts[partIndex].thought)) continue;
    const base = parts?.slice(0, partIndex).reduce((sum, part) => sum + (part.thought ? 0 : Buffer.byteLength(part.text ?? '')), 0) ?? 0;
    const start = segment.startIndex ?? 0;
    const end = segment.endIndex;
    const partLength = parts ? Buffer.byteLength(parts[partIndex]?.text ?? '') : bytes.length;
    let matched: typeof items = [];
    if (Number.isSafeInteger(start) && end !== undefined && Number.isSafeInteger(end) &&
      start >= 0 && end > start && end <= partLength &&
      (segment.text === undefined || bytes.subarray(base + start, base + end).toString('utf8') === segment.text)) {
      matched = items.filter(item => base + start < item.end && base + end > item.start);
    } else if (typeof segment.text === 'string' && segment.text.trim()) {
      const found = items.filter(item => item.raw.includes(segment.text!));
      if (found.length === 1) matched = found;
    }
    for (const index of support.groundingChunkIndices ?? []) {
      if (!Number.isSafeInteger(index) || index < 0) continue;
      const web = chunks[index]?.web;
      if (typeof web?.uri !== 'string' || !sourceUrl(web.uri)) continue;
      for (const item of matched) item.sources.set(web.uri, { title: web.title ?? web.uri, uri: web.uri });
    }
  }
  return new Map(items.map(item => [item.id, { notes: item.notes, sources: [...item.sources.values()] }]));
}
