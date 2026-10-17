import { getMockTranscript } from "./mock.js";
import type { GetTranscript } from "./provider.js";

export { type GetTranscript, type GetTranscriptOptions, isYouTubeVideoId, TranscriptNotFoundError, type VideoTranscript } from "./provider.js";
export { getMockTranscript } from "./mock.js";

/**
 * Transcript sources, selected with `TRANSCRIPT_SOURCE`. When the real function is ready, add it
 * here (for example `youtube: getYouTubeTranscript`) and set `TRANSCRIPT_SOURCE=youtube`.
 */
export const transcriptProviders = { mock: getMockTranscript } as const satisfies Record<string, GetTranscript>;

export type TranscriptSource = keyof typeof transcriptProviders;

export const isTranscriptSource = (value: string): value is TranscriptSource => Object.hasOwn(transcriptProviders, value);
