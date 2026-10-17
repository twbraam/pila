import type { Transcript } from '../../../shared/transcript';

export const transcript: Transcript = {
  videoId: '7wFWgopJP5Q',
  sentences: [
    { id: 'caption-1', text: 'A claim to check.', start: 1.123456, end: 3.234567 },
    { id: 'caption-2', text: 'An opinion.', start: 3.234567, end: 5 },
    { id: 'caption-3', text: 'Another claim.', start: 5, end: 7 },
  ],
};

function candidate(text: string, metadata = {}) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] }, ...metadata }] });
}

export function fakeGemini(options: { sources?: boolean; notes?: string; judging?: string; flagged?: boolean; scores?: number[] } = {}) {
  const calls: { url: string; body: { tools?: unknown; contents: { parts: { text: string }[] }[] } }[] = [];
  const notes = options.notes ?? '0: Sources contradict the first claim.\n2: Sources support the third claim.';
  const request: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    if (calls.length === 1) return candidate(JSON.stringify(transcript.sentences.map((_sentence, id) => ({
      id, score: options.scores?.[id] ?? (options.flagged === false ? 0 : id === 1 ? 1 : 4), reason: 'Screening rationale.',
    }))));
    if (calls.length === 2) return candidate(notes, {
      groundingMetadata: options.sources === false ? {} : {
        groundingChunks: [{ web: { uri: 'https://example.org/evidence', title: 'Evidence' } }],
        groundingSupports: [{ segment: { startIndex: 0, endIndex: Buffer.byteLength(notes), text: notes }, groundingChunkIndices: [0] }],
      },
    });
    if (calls.length === 3) return candidate(options.judging ?? JSON.stringify([
      { id: 2, verdict: 'truth', score: 0, reason: 'The third claim is supported.' },
      { id: 0, verdict: 'not_truth', score: 3, reason: 'The first claim is contradicted.' },
    ]));
    throw new Error('Unexpected extra API call.');
  };
  return { calls, fetch: request };
}
