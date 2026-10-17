import { transcribeWithGemini } from "./gemini.js";

export interface TranscriptSegment {
  text: string;
  /** Start time in seconds. */
  start: number;
  /** Duration in seconds. */
  duration: number;
}

export interface TranscriptResult {
  videoId: string;
  segments: TranscriptSegment[];
}

/** Accepts a bare video ID or any common YouTube URL and returns the ID. */
export function extractVideoId(input: string): string {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid YouTube URL or video ID: ${input}`);
  }

  const host = url.hostname.replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1).split("/")[0];
  } else if (host.endsWith("youtube.com")) {
    id =
      url.searchParams.get("v") ??
      url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1] ??
      null;
  }

  if (!id || !/^[\w-]{11}$/.test(id)) {
    throw new Error(`Could not find a video ID in: ${input}`);
  }
  return id;
}

export async function getTranscript(
  videoIdOrUrl: string,
  opts: { durationSeconds?: number; chunkSeconds?: number } = {},
): Promise<TranscriptResult> {
  const videoId = extractVideoId(videoIdOrUrl);
  return { videoId, segments: await transcribeWithGemini(videoId, opts) };
}

export function toPlainText(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join(" ");
}
