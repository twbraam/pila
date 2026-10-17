/**
 * Contract for the transcript function (owned by another teammate). Given a YouTube video ID, it
 * returns the caption segments. Until it ships, the API uses `getMockTranscript`.
 */
import type { Language, TranscriptSegment } from "@pila/factcheck";

export interface VideoTranscript {
  readonly videoId: string;
  /** Same shape as `ref/transcript.json`: `{ text, start, duration }`, seconds from the video start. */
  readonly segments: readonly TranscriptSegment[];
  /** The caption language, when known. Otherwise it is detected from the text. */
  readonly language?: Language | undefined;
}

export interface GetTranscriptOptions {
  /** Aborted when the client leaves or the request times out (55 s). */
  readonly signal?: AbortSignal | undefined;
}

export type GetTranscript = (videoId: string, options?: GetTranscriptOptions) => Promise<VideoTranscript>;

/** Throw this when the video has no usable captions. The API answers 404 `transcript_not_found`. */
export class TranscriptNotFoundError extends Error {
  constructor(message = "This video has no usable transcript") {
    super(message);
    this.name = "TranscriptNotFoundError";
  }
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const isYouTubeVideoId = (value: unknown): value is string => typeof value === "string" && YOUTUBE_VIDEO_ID.test(value);
