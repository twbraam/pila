import { fetchTranscript, type TranscriptConfig, type TranscriptSegment } from 'youtube-transcript-plus';
import type { Transcript } from '../shared/transcript';
import { normalizeCaptions } from './normalize';
import { parseVideoId } from './video-id';

export { assertTranscript, type Transcript, type TranscriptSentence } from '../shared/transcript';
export { normalizeCaptions } from './normalize';
export { parseVideoId } from './video-id';
export type { TranscriptSegment as CaptionSegment } from 'youtube-transcript-plus';

export interface ExtractOptions {
  /** Exact caption language to request. Defaults to English. */
  lang?: string;
  /** Timeout for all caption requests, in milliseconds. Defaults to 30,000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Injectable caption provider for offline tests or a future extension transport. */
export type CaptionFetcher = (
  videoId: string,
  config: TranscriptConfig,
) => Promise<TranscriptSegment[]>;

/** Fetch all captions and return one validated sentence-level handoff. Errors reject. */
export async function extractTranscript(
  input: string,
  options: ExtractOptions = {},
  fetcher: CaptionFetcher = fetchTranscript,
): Promise<Transcript> {
  const videoId = parseVideoId(input);
  const lang = options.lang ?? 'en';
  // Validate the language before making a network request.
  Intl.getCanonicalLocales(lang);
  if (!lang) throw new TypeError('Caption language must not be empty.');

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be an integer between 1 and 2147483647.');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const captions = await fetcher(videoId, { lang, signal });
  signal.throwIfAborted();
  const transcript = normalizeCaptions(videoId, captions, lang);
  if (transcript.sentences.length === 0) {
    throw new Error(`No usable captions returned for ${videoId}.`);
  }
  return transcript;
}
