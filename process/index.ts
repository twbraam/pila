import { assertTranscript, type Transcript } from '../shared/transcript';
import { assertOverlayResults, type OverlayResults } from '../shared/overlay-results';
import { check, type CheckResult } from './check';
import type { ProcessOptions } from './config';

export type { ProcessOptions } from './config';
export { ProcessConfigurationError } from './config';

/** Map only sourced, verified problems to the public contract, using source IDs. */
export function toOverlayResults(transcript: Transcript, result: CheckResult): OverlayResults {
  assertTranscript(transcript);
  if (result.videoId !== transcript.videoId) throw new Error('Process result belongs to another video.');
  const verified = new Map(result.verified.map(sentence => [sentence.sentenceId, sentence]));
  if (verified.size !== result.verified.length) throw new Error('Duplicate verified sentence ID.');
  const originals = new Set(transcript.sentences.map(sentence => sentence.id));
  if ([...verified.keys()].some(id => !originals.has(id))) throw new Error('Unknown verified sentence ID.');
  const output: OverlayResults = [];
  for (const original of transcript.sentences) {
    const sentence = verified.get(original.id);
    if (!sentence || sentence.suspicionScore <= 3 || sentence.verdict !== 'not_truth' || sentence.sources.length === 0) continue;
    output.push({
      timestamp: original.start,
      sentence: original.text,
      score: sentence.suspicionScore,
      explanation: sentence.reason,
      sources: [...new Set(sentence.sources.map(source => source.uri))],
    });
  }
  assertOverlayResults(output);
  return output;
}

/** Extract's in-memory Transcript -> screen -> search -> judge -> Overlay array. */
export async function processTranscript(transcript: Transcript, options: ProcessOptions = {}): Promise<OverlayResults> {
  return toOverlayResults(transcript, await check(transcript, options));
}
