import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertTranscript, extractTranscript, normalizeCaptions, parseVideoId,
  type CaptionSegment, type Transcript,
} from '../index';

const VIDEO_ID = 'OwqIy8Ikv-c';
const cue = (text: string, offset: number, duration: number): CaptionSegment => ({
  text, offset, duration, lang: 'en',
});

test('parses supported YouTube URLs and IDs without accepting unrelated hosts', () => {
  for (const input of [
    VIDEO_ID, ` ${VIDEO_ID} `,
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=10`,
    `https://m.youtube.com/watch?t=10&v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?si=abc`,
    `https://youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://youtube.com/live/${VIDEO_ID}`,
    `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
  ]) assert.equal(parseVideoId(input), VIDEO_ID);
  for (const input of [
    '', 'invalid', `https://example.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com.evil.example/watch?v=${VIDEO_ID}`,
    `https://notyoutube.com/watch?v=${VIDEO_ID}`,
    'https://youtube.com/watch?v=too-short', `ftp://youtube.com/watch?v=${VIDEO_ID}`,
  ]) assert.throws(() => parseVideoId(input), TypeError);
});

test('assembles split captions, shares cue timings, and retains a final fragment', () => {
  const captions = [
    cue('A\n claim', 0, 2), cue('continues. Another statement.', 2, 3),
    cue('Last fragment', 5, 2),
  ];
  const before = structuredClone(captions);
  assert.deepEqual(normalizeCaptions(VIDEO_ID, captions), {
    videoId: VIDEO_ID,
    sentences: [
      { id: 's0001', text: 'A claim continues.', start: 0, end: 5 },
      { id: 's0002', text: 'Another statement.', start: 2, end: 5 },
      { id: 's0003', text: 'Last fragment', start: 5, end: 7 },
    ],
  });
  assert.deepEqual(captions, before);
  assert.deepEqual(normalizeCaptions(VIDEO_ID, captions), normalizeCaptions(VIDEO_ID, captions));
});

test('sorts captions stably and retains the longest contributing overlapping range', () => {
  const transcript = normalizeCaptions(VIDEO_ID, [
    cue('continues.', 2, 1), cue('A claim', 0, 10),
    cue('Next sentence.', 2, 2), cue(' \n ', 3, 1),
  ]);
  assert.deepEqual(transcript.sentences, [
    { id: 's0001', text: 'A claim continues.', start: 0, end: 10 },
    { id: 's0002', text: 'Next sentence.', start: 2, end: 4 },
  ]);
});

test('handles Chinese punctuation and keeps an unpunctuated passage together', () => {
  const chinese = normalizeCaptions(VIDEO_ID, [
    { ...cue('我是科學家。這是真的！', 1.25, 2.5), lang: 'zh-TW' },
  ]);
  assert.deepEqual(chinese.sentences, [
    { id: 's0001', text: '我是科學家。', start: 1.25, end: 3.75 },
    { id: 's0002', text: '這是真的！', start: 1.25, end: 3.75 },
  ]);
  assert.equal(normalizeCaptions(VIDEO_ID, [
    cue('no punctuation', 1, 1), cue('in these captions', 3, 1),
  ]).sentences[0]?.text, 'no punctuation in these captions');
});

test('normalization rejects invalid source timings rather than fabricating end times', () => {
  for (const caption of [
    cue('Text.', -1, 1), cue('Text.', NaN, 1), cue('Text.', 0, 0),
    cue('Text.', 0, -1), cue('Text.', 0, Infinity),
    cue('Text.', Number.MAX_VALUE, Number.MAX_VALUE), cue('Text.', Number.MAX_VALUE, 1),
  ]) assert.throws(() => normalizeCaptions(VIDEO_ID, [caption]), /Invalid caption/);
});

test('validates the contract including unique IDs, finite ranges, and playback order', () => {
  const valid: Transcript = {
    videoId: VIDEO_ID,
    sentences: [{ id: 's0001', text: 'A sentence.', start: 1, end: 2 }],
  };
  assertTranscript(valid);
  assertTranscript({ videoId: VIDEO_ID, sentences: [] });
  const sentence = valid.sentences[0]!;
  for (const value of [
    null, [], { videoId: 'bad', sentences: [] }, { ...valid, unexpected: true },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, extra: true }] },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, text: ' \n ' }] },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, id: '' }] },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, start: -1 }] },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, start: NaN }] },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, end: Infinity }] },
    { videoId: VIDEO_ID, sentences: [{ ...sentence, end: 1 }] },
    { videoId: VIDEO_ID, sentences: [sentence, sentence] },
    { videoId: VIDEO_ID, sentences: [sentence, { ...sentence, id: 's0002', start: 0 }] },
  ]) assert.throws(() => assertTranscript(value), TypeError);
});

test('normalizes bilingual captions without losing caption text', () => {
  const captions = [
    cue('我是科學家\nI’m a scientist.', 1.25, 2.5),
    cue('這句話繼續\nThis sentence continues', 4, 2),
    cue('到下一段\ninto the next caption.', 6, 2.25),
  ];
  const result = normalizeCaptions(VIDEO_ID, captions);
  assertTranscript(result);
  const expected = captions.map(({ text }) => text.replace(/\s+/gu, ' ').trim()).join(' ');
  const actual = result.sentences.map(({ text }) => text).join(' ');
  // Boundaries can add whitespace after punctuation, but must not lose text.
  assert.equal(actual.replace(/\s/gu, ''), expected.replace(/\s/gu, ''));
  assert.equal(result.sentences[0]?.start, captions[0]?.offset);
  assert.equal(result.sentences.at(-1)?.end, captions.at(-1)!.offset + captions.at(-1)!.duration);
});

test('extracts one whole transcript with the requested language and abort signal', async () => {
  let calls = 0;
  const result = await extractTranscript(`https://youtu.be/${VIDEO_ID}`, { lang: 'zh-TW' }, async (id, config) => {
    calls += 1;
    assert.equal(id, VIDEO_ID);
    assert.equal(config.lang, 'zh-TW');
    assert(config.signal instanceof AbortSignal);
    return [{ ...cue('一句話。', 1, 2), lang: 'zh-TW' }];
  });
  assert.equal(calls, 1);
  assert.equal(result.videoId, VIDEO_ID);
  assert.equal(result.sentences[0]?.text, '一句話。');
});

test('the documented live JSON example is a valid Processing handoff', async () => {
  const transcript: unknown = JSON.parse(await readFile('examples/transcripts/extracted.json', 'utf8'));
  assertTranscript(transcript);
  assert.equal(transcript.videoId, VIDEO_ID);
  assert.equal(transcript.sentences.length, 36);
  assert.equal(transcript.sentences[0]?.text, 'I’m an atmospheric physicist.');
});

test('propagates provider failures and rejects empty captions', async () => {
  const failure = new Error('HTTP 429');
  await assert.rejects(extractTranscript(VIDEO_ID, {}, async () => { throw failure; }), (error) => error === failure);
  await assert.rejects(extractTranscript(VIDEO_ID, {}, async () => []), /No usable captions/);
  await assert.rejects(extractTranscript(VIDEO_ID, {}, async () => [cue(' \n ', 0, 1)]), /No usable captions/);
});

test('invalid options and pre-cancellation fail before fetching', async () => {
  const fetcher = async (): Promise<CaptionSegment[]> => { throw new Error('Should not fetch'); };
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    await assert.rejects(extractTranscript(VIDEO_ID, { timeoutMs }, fetcher), /timeoutMs/);
  }
  await assert.rejects(extractTranscript(VIDEO_ID, { lang: 'invalid_language' }, fetcher), RangeError);
  await assert.rejects(extractTranscript(VIDEO_ID, { lang: '' }, fetcher), /language/);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await assert.rejects(extractTranscript(VIDEO_ID, { signal: controller.signal }, fetcher), /Cancelled/);
});

test('cancels an in-flight provider when the extraction deadline expires', async () => {
  // AbortSignal.timeout uses an unref timer; keep the test alive until it fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(extractTranscript(VIDEO_ID, { timeoutMs: 20 }, async (_id, { signal }) => {
      assert(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }), { name: 'TimeoutError' });
  } finally {
    clearInterval(keepAlive);
  }
});
