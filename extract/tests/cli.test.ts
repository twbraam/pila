import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertTranscript } from '../../shared/transcript';

const VIDEO_ID = 'OwqIy8Ikv-c';
const root = process.cwd();
function run(args: string[], mode = 'ok', cwd = root) {
  return spawnSync(process.execPath, [
    '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    '--import', resolve(root, 'extract/tests/fixtures/youtube-fetch.ts'),
    resolve(root, 'extract/main.ts'), ...args,
  ], {
    cwd, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PILA_TEST_CAPTION_MODE: mode },
  });
}

test('CLI stdout contains only the normalized JSON contract', () => {
  const result = run([VIDEO_ID]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const transcript: unknown = JSON.parse(result.stdout);
  assertTranscript(transcript);
  assert.equal(transcript.videoId, VIDEO_ID);
  assert.equal(transcript.sentences.length, 3);
  assert.equal(transcript.sentences[0]?.text, 'A claim continues.');
});

test('CLI writes only the requested JSON file and no subtitle files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pila-extract-'));
  try {
    const result = run([VIDEO_ID, '--out', 'transcript.json'], 'ok', directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assertTranscript(JSON.parse(await readFile(join(directory, 'transcript.json'), 'utf8')));
    assert.deepEqual(await readdir(directory), ['transcript.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI failures write no JSON and preserve an existing destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pila-extract-failure-'));
  try {
    const destination = join(directory, 'transcript.json');
    await writeFile(destination, 'previous output', 'utf8');
    for (const [mode, errorName] of [
      ['rate-limited', 'YoutubeTranscriptTooManyRequestError'],
      ['disabled', 'YoutubeTranscriptDisabledError'],
      ['empty', 'YoutubeTranscriptNotAvailableError'],
    ]) {
      const result = run([VIDEO_ID, '--out', destination], mode);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert(result.stderr.includes(errorName!), result.stderr);
      assert.equal(await readFile(destination, 'utf8'), 'previous output');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects invalid arguments and explains usage', () => {
  for (const args of [[], [VIDEO_ID, VIDEO_ID], ['bad-id'], [VIDEO_ID, '--format', 'srt'], [VIDEO_ID, '--timeout', '0']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Extract failed:/);
  }
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Transcript as JSON/);
});
