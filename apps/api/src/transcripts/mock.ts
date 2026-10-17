import type { TranscriptSegment } from "@pila/factcheck";
import mockSegments from "./mock-transcript.json" with { type: "json" };
import type { GetTranscript } from "./provider.js";

/**
 * Stand-in for the real transcript function: returns the team's sample transcript
 * (a copy of `ref/transcript.json`, the PragerU Lindzen video) for any video ID.
 */
export const getMockTranscript: GetTranscript = async (videoId, options = {}) => {
  options.signal?.throwIfAborted();
  return { videoId, segments: mockSegments as readonly TranscriptSegment[] };
};
