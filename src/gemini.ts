import type { TranscriptSegment } from "./transcript.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

const PROMPT = `Transcribe the speech in this video verbatim.
Return a JSON array of segments, each with:
- "start": start time in seconds (number)
- "text": the spoken text for that segment
Use segments of roughly one sentence. Do not summarize or translate.`;

/**
 * Transcribes a public YouTube video by passing its URL directly to Gemini.
 * Requires GEMINI_API_KEY in the environment.
 */
export async function transcribeWithGemini(
  videoId: string,
): Promise<TranscriptSegment[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

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
  if (!text) throw new Error("Gemini returned no transcript");

  const parsed = JSON.parse(text) as { start: number; text: string }[];
  return parsed.map((seg, i) => ({
    text: seg.text.trim(),
    start: seg.start,
    // Gemini gives only start times; derive duration from the next segment.
    duration: i + 1 < parsed.length ? Math.max(0, parsed[i + 1].start - seg.start) : 0,
  }));
}
