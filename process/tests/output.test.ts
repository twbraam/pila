import assert from 'node:assert/strict';
import test from 'node:test';
import { processTranscript, toOverlayResults } from '../index';
import { check } from '../check';
import { transcript, fakeGemini } from './fixtures/gemini';

test('public output includes only sourced problems, retaining the screening score and verifier explanation', async () => {
  const fake = fakeGemini({ scores: [4.253, 1, 4] });
  assert.deepEqual(await processTranscript(transcript, { apiKey: 'offline', fetch: fake.fetch }), [{
    timestamp: 1.123456,
    sentence: 'A claim to check.',
    score: 4.253,
    explanation: 'The first claim is contradicted.',
    sources: ['https://example.org/evidence'],
  }]);
});

test('score 3 is excluded, just above 3 is included, and 5 is included', async () => {
  for (const score of [3, 3.00001, 5]) {
    const fake = fakeGemini({
      scores: [score, 0, 0], notes: '0: Sources contradict this claim.',
      judging: JSON.stringify([{ id: 0, verdict: 'not_truth', reason: 'Evidence contradicts the claim.' }]),
    });
    const results = await processTranscript(transcript, { apiKey: 'offline', fetch: fake.fetch });
    assert.deepEqual(results.map(result => result.score), score === 3 ? [] : [score]);
    assert.equal(fake.calls.length, score === 3 ? 1 : 3);
  }
});

test('no flagged or sourced problems returns a successful empty array', async () => {
  for (const fake of [fakeGemini({ flagged: false }), fakeGemini({ sources: false })]) {
    assert.deepEqual(await processTranscript(transcript, { apiKey: 'offline', fetch: fake.fetch }), []);
  }
});

test('mapping joins original IDs and text in transcript order and deduplicates source URLs', async () => {
  const fake = fakeGemini();
  const result = await check(transcript, { apiKey: 'offline', fetch: fake.fetch });
  result.verified.reverse();
  for (const sentence of result.verified) {
    sentence.verdict = 'not_truth';
    sentence.text = 'Model rewrite that must not appear in output.';
    sentence.start = 99;
    sentence.sources.push(...sentence.sources);
  }
  const output = toOverlayResults(transcript, result);
  assert.deepEqual(output.map(row => [row.timestamp, row.sentence]), [
    [1.123456, 'A claim to check.'], [5, 'Another claim.'],
  ]);
  assert(output.every(row => row.sources.length === 1));
  for (const invalid of [
    { ...result, videoId: 'OwqIy8Ikv-c' },
    { ...result, verified: [...result.verified, result.verified[0]!] },
    { ...result, verified: [{ ...result.verified[0]!, sentenceId: 'unknown' }] },
  ]) assert.throws(() => toOverlayResults(transcript, invalid));
});
