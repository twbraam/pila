import assert from 'node:assert/strict';
import test from 'node:test';
import { check, parseVerdicts } from '../check';

import { transcript, fakeGemini } from './fixtures/gemini';

test('screen and verify uses shared input, verifies only flagged IDs, and retains sentence provenance', async () => {
  const fake = fakeGemini();
  const result = await check(transcript, { apiKey: 'offline', fetch: fake.fetch });
  assert.equal(fake.calls.length, 3);
  assert.match(fake.calls[0]!.url, /gemini-3\.5-flash-lite:/);
  assert.match(fake.calls[1]!.url, /gemini-3\.8-flash:/);
  assert.deepEqual(fake.calls[1]!.body.tools, [{ google_search: {} }]);
  assert.equal(fake.calls[2]!.body.tools, undefined);
  assert.equal(result.flaggedCount, 2);
  assert.deepEqual(result.counts, { truth: 1, not_truth: 1, unchecked: 0 });
  assert.deepEqual(result.verified.map(row => [row.sentenceId, row.text, row.start, row.end]), [
    ['caption-1', 'A claim to check.', 1.123456, 3.234567], ['caption-3', 'Another claim.', 5, 7],
  ]);
  assert.equal(result.notTrue[0]?.sentenceId, 'caption-1');
  assert.deepEqual(result.verified[0]?.sources.map(source => source.uri), ['https://example.org/evidence']);
});

test('screening with no flagged sentences makes no search or judging calls', async () => {
  const fake = fakeGemini({ flagged: false });
  const result = await check(transcript, { apiKey: 'offline', fetch: fake.fetch });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(result.verified, []);
});

test('unsupported verdicts remain unchecked even if the judge claims certainty', async () => {
  const fake = fakeGemini({ sources: false });
  const result = await check(transcript, { apiKey: 'offline', fetch: fake.fetch });
  assert.deepEqual(result.counts, { truth: 0, not_truth: 0, unchecked: 2 });
  assert.deepEqual(result.notTrue, []);
  assert(result.verified.every(row => row.sources.length === 0));
});

test('grounding and judging omissions are errors, not partial successful checks', async () => {
  for (const fake of [fakeGemini({ notes: '0: Only one finding.' }), fakeGemini({ judging: '[]' })]) {
    await assert.rejects(check(transcript, { apiKey: 'offline', fetch: fake.fetch }), /omitted|every flagged/);
  }
});

test('judging rejects duplicate, unknown, invalid, and missing IDs', () => {
  const row = { id: 0, verdict: 'truth', reason: 'A reason.' };
  for (const rows of [null, {}, [], [null], [row, row], [{ ...row, id: 2 }], [{ ...row, id: -1 }],
    [{ ...row, id: 0.5 }], [{ ...row, verdict: 'unknown' }], [{ ...row, reason: 1 }]]) {
    assert.throws(() => parseVerdicts(JSON.stringify(rows), [0]));
  }
});
