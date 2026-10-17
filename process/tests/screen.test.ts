import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transcript } from '../../shared/transcript';
import { parseScores, screen } from '../screen';
import { parseNotes } from '../grounding';

const transcript: Transcript = {
  videoId: '7wFWgopJP5Q',
  sentences: [
    { id: 'original-caption', text: '這是一句話。\nA claim.', start: 1.234567, end: 8.987654 },
    { id: 'another-id', text: 'Another sentence.', start: 8.987654, end: 12 },
  ],
};

test('screening preserves original IDs, text, and timing without rounding', async () => {
  const result = await screen(transcript, {
    apiKey: 'offline-key',
    fetch: async (input, init) => {
      assert.match(String(input), /gemini-3\.5-flash-lite:generateContent$/);
      assert(init?.signal instanceof AbortSignal);
      const body = JSON.parse(String(init.body));
      assert(body.contents[0].parts[0].text.includes(transcript.sentences[0]!.text));
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([
        { id: 1, score: 2, reason: 'Specific claim.' },
        { id: 0, score: 2.01, reason: 'Needs checking.' },
      ]) }] } }] });
    },
  });
  assert.equal(result.targets[0]?.sentenceId, 'original-caption');
  assert.equal(result.targets[0]?.text, transcript.sentences[0]?.text);
  assert.equal(result.targets[0]?.start, 1.234567);
  assert.equal(result.targets[0]?.end, 8.987654);
  assert.deepEqual(result.targets.map(target => target.suspectedIssue), [true, false]);
});

test('screening rejects missing, duplicate, unknown, malformed, and out-of-range scores', () => {
  const valid = { id: 0, score: 3.01, reason: 'A reason.' };
  for (const rows of [null, {}, [], [valid, valid], [{ ...valid, id: 1 }],
    [{ ...valid, score: 6 }], [{ ...valid, score: -1 }], [{ ...valid, score: '3' }],
    [{ ...valid, id: 0.5 }], [{ ...valid, reason: '' }], [null]]) {
    assert.throws(() => parseScores(JSON.stringify(rows), 1));
  }
});

test('blocked, truncated, missing, and malformed model responses fail', async () => {
  for (const response of [
    {}, { candidates: [] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '[]' }] } }] },
    { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '[]' }] } }] },
    { candidates: [{ content: { parts: [{ text: 12 }] } }] },
    { candidates: [{ content: { parts: [{ thought: true, text: 'internal reasoning only' }] } }] },
  ]) {
    await assert.rejects(screen(transcript, { apiKey: 'offline', fetch: async () => Response.json(response) }));
  }
});

test('source attribution uses UTF-8 offsets for Chinese and per-part offsets', () => {
  const first = '0: 中文證據。\n';
  const second = '1: 第二項證據。';
  const notes = parseNotes(first + second, {
    groundingChunks: [{ web: { uri: 'https://example.org/first' } }, { web: { uri: 'https://example.org/second' } }],
    groundingSupports: [
      { segment: { startIndex: 0, endIndex: Buffer.byteLength(first.trim()) }, groundingChunkIndices: [0] },
      { segment: { partIndex: 1, startIndex: 0, endIndex: Buffer.byteLength(second) }, groundingChunkIndices: [1] },
    ],
  }, [{ text: first }, { text: second }]);
  assert.deepEqual(notes.get(0)?.sources.map(source => source.uri), ['https://example.org/first']);
  assert.deepEqual(notes.get(1)?.sources.map(source => source.uri), ['https://example.org/second']);
});

test('source attribution handles spans across lines and ignores unsafe or unrelated sources', () => {
  const text = '0: First finding.\n1: Second finding.';
  const notes = parseNotes(text, {
    groundingChunks: [{ web: { uri: 'https://example.org/evidence' } }, { web: { uri: 'javascript:alert(1)' } }],
    groundingSupports: [{ segment: { startIndex: 0, endIndex: Buffer.byteLength(text), text }, groundingChunkIndices: [0, 1] }],
  });
  assert.deepEqual([...notes.values()].map(note => note.sources.map(source => source.uri)), [
    ['https://example.org/evidence'], ['https://example.org/evidence'],
  ]);
  const unattached = parseNotes(text, {
    groundingChunks: [{ web: { uri: 'https://example.org/unrelated' } }],
  });
  assert.deepEqual([...unattached.values()].map(note => note.sources), [[], []]);
});

test('cancellation and the processing deadline stop pending requests', async () => {
  let called = false;
  await assert.rejects(screen(transcript, {
    apiKey: 'offline', signal: AbortSignal.abort(),
    fetch: async () => { called = true; throw new Error('Must not call'); },
  }), { name: 'AbortError' });
  assert.equal(called, false);
  // Keep the event loop alive: AbortSignal.timeout itself is unref'ed by Node.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(screen(transcript, {
      apiKey: 'offline', timeoutMs: 20,
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    }), { name: 'TimeoutError' });
  } finally { clearInterval(keepAlive); }
});

test('HTTP errors do not expose provider bodies or API keys', async () => {
  await assert.rejects(screen(transcript, {
    apiKey: 'secret-api-key',
    fetch: async () => new Response('secret-api-key and private transcript', { status: 429 }),
  }), error => error instanceof Error && /429/.test(error.message) && !/secret|private/.test(error.message));
});
