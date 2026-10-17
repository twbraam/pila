import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertOverlayResults, type OverlayResult, type OverlayResults } from '../overlay-results';

const result: OverlayResult = {
  timestamp: 42.5,
  sentence: 'Sample excerpt from video speech or transcript',
  score: 4.25,
  explanation: 'The cited evidence contradicts the claim.',
  sources: ['https://factcheck.org/...'],
};

test('Overlay results accept original suspicion ratings above 2, exact timestamps, Unicode, and no results', () => {
  const results: OverlayResults = [2.0001, 2.5, 3, 3.5, 4, 5].map(score => ({ ...result, score }));
  assertOverlayResults(results);
  assertOverlayResults([]);
  assertOverlayResults([{ ...result, timestamp: 0, sentence: '這是一句話。' }]);
  assertOverlayResults([{ ...result, sources: ['http://example.org/evidence', 'https://example.org/other'] }]);
});

test('Overlay scores must be finite numbers strictly above 2 and at most 5 without coercion', () => {
  for (const score of [-1, 0, 1, 2, 5.001, 6, NaN, Infinity, '4', null, undefined, true]) {
    assert.throws(() => assertOverlayResults([{ ...result, score }]), /Invalid Overlay result/);
  }
});

test('Overlay output requires all five fields and rejects wrappers and extra fields', () => {
  for (const value of [null, {}, { results: [result] }, result, '[]']) {
    assert.throws(() => assertOverlayResults(value), /top-level array/);
  }
  for (const value of [null, [], 'result', 42]) {
    assert.throws(() => assertOverlayResults([value]), /Invalid Overlay result/);
  }
  for (const key of Object.keys(result)) {
    const missing: Record<string, unknown> = { ...result };
    delete missing[key];
    assert.throws(() => assertOverlayResults([missing]), /Invalid Overlay result/);
  }
  const { timestamp, sentence, explanation, sources } = result;
  const withoutScore = { timestamp, sentence, explanation, sources };
  assert.throws(() => assertOverlayResults([withoutScore]), /Invalid Overlay result/);
  assert.throws(() => assertOverlayResults([{ ...result, reason: 'Extra field' }]), /Invalid Overlay result/);
});

test('Overlay timestamps are finite, nonnegative, and chronological with ties allowed', () => {
  for (const timestamp of [-1, NaN, Infinity, -Infinity, '42.5', null]) {
    assert.throws(() => assertOverlayResults([{ ...result, timestamp }]), /Invalid Overlay result/);
  }
  assertOverlayResults([{ ...result, timestamp: 0 }, result, result]);
  assert.throws(() => assertOverlayResults([result, { ...result, timestamp: 1 }]), /timestamp order/);
});

test('Overlay results require original text, an explanation, and at least one HTTP(S) source', () => {
  for (const sentence of ['', ' \n ', 42, null]) {
    assert.throws(() => assertOverlayResults([{ ...result, sentence }]), /Invalid Overlay result/);
  }
  for (const explanation of ['', ' \n ', null, 42]) {
    assert.throws(() => assertOverlayResults([{ ...result, explanation }]), /Invalid Overlay result/);
  }
  for (const sources of [[], null, 'https://example.org', [42], [''], ['not a URL'], ['https://'],
    ['ftp://example.org'], ['javascript:alert(1)'], [' https://example.org'], ['https://example.org/a b']]) {
    assert.throws(() => assertOverlayResults([{ ...result, sources }]), /Invalid Overlay result/);
  }
});

test('the portable schema and README examples use the same five-field output contract', async () => {
  const schema = JSON.parse(await readFile('shared/overlay-results.schema.json', 'utf8'));
  assert.equal(schema.type, 'array');
  assert.equal(schema.items.additionalProperties, false);
  assert.deepEqual(schema.items.required, ['timestamp', 'sentence', 'score', 'explanation', 'sources']);
  assert.deepEqual(schema.items.properties.score, { type: 'number', exclusiveMinimum: 2, maximum: 5 });
  const examples: unknown[] = [];
  for (const path of ['README.md', 'process/README.md']) {
    const markdown = await readFile(path, 'utf8');
    for (const [, block] of markdown.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const value: unknown = JSON.parse(block!);
      if (Array.isArray(value)) {
        assertOverlayResults(value);
        examples.push(value);
      }
    }
  }
  assert.equal(examples.length, 2);
  assert.deepEqual(examples[0], examples[1]);
});
