import type { TranscriptSegment } from "./transcript.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

/**
 * Gemini caps input at ~1M tokens and video costs roughly 300 tokens/second,
 * so long videos must be sent in clips. 20 minutes leaves plenty of headroom.
 */
const DEFAULT_CHUNK_SECONDS = Number(process.env.GEMINI_CHUNK_SECONDS ?? 1200);

/** Shown for the very last segment, which has no following start time. */
const LAST_SEGMENT_DURATION = 3;

const PROMPT = `Transcribe the speech in this video clip verbatim.
Return a JSON array of segments, each with:
- "start": start time in seconds, counted from the beginning of THIS clip (number)
- "text": the spoken text for that segment
Use segments of roughly one sentence. Do not summarize or translate.`;

type RawSegment = { start: number; text: string };

/** Reads the video length from the watch page (no API key needed). */
export async function getVideoDuration(videoId: string): Promise<number> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en" },
  });
  const html = await res.text();
  const m = html.match(/"lengthSeconds":"(\d+)"/);
  if (!m) {
    throw new Error(
      "Could not read the video length from YouTube; pass it with --duration <seconds>",
    );
  }
  return Number(m[1]);
}

async function transcribeClip(
  videoId: string,
  startSec: number,
  endSec: number,
  apiKey: string,
): Promise<RawSegment[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                file_data: {
                  file_uri: `https://www.youtube.com/watch?v=${videoId}`,
                },
                video_metadata: {
                  start_offset: `${startSec}s`,
                  end_offset: `${endSec}s`,
                },
              },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                start: { type: "NUMBER" },
                text: { type: "STRING" },
              },
              required: ["start", "text"],
            },
          },
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini returned no transcript for ${startSec}s-${endSec}s`);

  return JSON.parse(text) as RawSegment[];
}

/**
 * Transcribes a public YouTube video by passing its URL to Gemini in clips,
 * then stitches the clips back together on one timeline.
 * Requires GEMINI_API_KEY in the environment.
 */
export async function transcribeWithGemini(
  videoId: string,
  opts: { durationSeconds?: number; chunkSeconds?: number } = {},
): Promise<TranscriptSegment[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const chunk = opts.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
  const total = opts.durationSeconds ?? (await getVideoDuration(videoId));
  const clips = Math.ceil(total / chunk);

  const merged: RawSegment[] = [];
  // Clips run one at a time to stay clear of rate limits.
  for (let i = 0; i < clips; i++) {
    const startSec = i * chunk;
    const endSec = Math.min(total, startSec + chunk);
    const t0 = performance.now();
    const raw = await transcribeClip(videoId, startSec, endSec, apiKey);
    console.error(
      `Clip ${i + 1}/${clips} (${startSec}s-${endSec}s): ${raw.length} segments, ` +
        `${((performance.now() - t0) / 1000).toFixed(1)}s`,
    );
    for (const seg of raw) {
      merged.push({ text: seg.text, start: seg.start + startSec });
    }
  }

  // Gemini gives only start times; derive each duration from the next
  // segment, which also bridges the gap between clips.
  return merged.map((seg, i) => ({
    text: seg.text.trim(),
    start: seg.start,
    duration:
      i + 1 < merged.length
        ? Math.max(0, merged[i + 1].start - seg.start)
        : LAST_SEGMENT_DURATION,
  }));
}
