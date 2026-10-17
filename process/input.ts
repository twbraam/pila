import { readFile } from 'node:fs/promises';
import { assertTranscript, type Transcript } from '../shared/transcript';

/** CLI and library use the same validated Extract -> Process contract. */
export async function readTranscript(path: string): Promise<Transcript> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assertTranscript(value);
  return value;
}
