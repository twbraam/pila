import type { TranscriptSegment } from "../extract/transcript.js";
import { clock } from "./factcheck.js";

const MODEL = process.env.SCREEN_MODEL ?? "gemini-3.5-flash-lite";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Lowest reasoning the model allows: 2.5 models can turn it off, 3.x models use levels. */
const THINKING = /^gemini-2\.5/.test(MODEL)
  ? { thinkingBudget: 0 }
  : { thinkingLevel: "minimal" };

export const DEFAULT_THRESHOLD = 3;
const MAX_SCORE = 5;

export interface ScreenTarget {
  videoId: string | null;
  sentenceId: string;
  text: string;
  start: number;
  end: number;
  screeningType: "score";
  /** 0 = nothing to check or clearly fine, 5 = very likely false or misleading. */
  suspicionScore: number;
  reviewThreshold: number;
  suspectedIssue: boolean;
  /** One or two sentences on why the sentence got this score, for every sentence. */
  explanation: string;
  nextStep: "verify_claim" | "not_prioritized";
  /** Screening never decides truth; that is the fact-check step's job. */
  truthStatus: "not_assessed";
}

export interface ScreenResult {
  status: "completed";
  model: string;
  latencyMs: number;
  targets: ScreenTarget[];
}

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "INTEGER" },
      score: { type: "NUMBER" },
      reason: { type: "STRING" },
    },
    required: ["id", "score", "reason"],
  },
};

function prompt(numbered: string[]): string {
  return `You are screening a video transcript (speech-to-text) for sentences that deserve a fact-check. Read all of it first, then score EVERY numbered line for how suspicious its factual content is. You are not deciding what is true, only what is worth checking.

Score each line from 0 to ${MAX_SCORE} (decimals allowed):
- 0 to 0.9: no factual claim (greeting, opinion, filler, question), or a trivial well-known fact.
- 1 to 1.9: a factual claim that is plausible and specific enough to be worth a look, but nothing looks off.
- 2 to 2.9: a checkable claim that is surprising, one-sided, loaded, or stated with unwarranted certainty.
- 3 to 3.9: a claim that is likely wrong, exaggerated, misleading, out of date, or contradicted by the rest of the video.
- 4 to ${MAX_SCORE}: a claim that looks clearly false, or a well-known myth.

Use the surrounding lines as context. For EVERY line, give a one or two sentence "reason" explaining why it got that score: name the specific thing that makes it suspicious (the claim, the wording, the missing context), or say why it is not worth checking (for example "opinion, no checkable fact" or "well-established fact"). Do not just repeat the sentence. Return one item for every line.

Transcript:
${numbered.join("\n")}`;
}

/** Reads the screening JSON. Exported so it can be tested without calling the API. */
export function parseScores(text: string): Map<number, { score: number; reason: string }> {
  const out = new Map<number, { score: number; reason: string }>();
  const arr = JSON.parse(text) as { id: number; score: number; reason?: string }[];
  for (const o of arr) {
    if (typeof o.id !== "number" || typeof o.score !== "number" || !Number.isFinite(o.score)) continue;
    out.set(o.id, {
      score: Math.round(Math.min(MAX_SCORE, Math.max(0, o.score)) * 100) / 100,
      reason: (o.reason ?? "").trim(),
    });
  }
  return out;
}

/** Turns scores into the target list. Exported so it can be tested without calling the API. */
export function buildTargets(
  segments: TranscriptSegment[],
  scores: Map<number, { score: number; reason: string }>,
  videoId: string | null,
  threshold: number,
): ScreenTarget[] {
  return segments.map((seg, i) => {
    const s = scores.get(i);
    const suspicionScore = s?.score ?? 0;
    const suspectedIssue = suspicionScore >= threshold;
    return {
      videoId,
      sentenceId: `s${String(i + 1).padStart(4, "0")}`,
      text: seg.text.replace(/\s*\n\s*/g, " "),
      start: seg.start,
      end: Math.round((seg.start + seg.duration) * 100) / 100,
      screeningType: "score",
      suspicionScore,
      reviewThreshold: threshold,
      suspectedIssue,
      explanation: s?.reason || "The model returned no explanation for this sentence.",
      nextStep: suspectedIssue ? "verify_claim" : "not_prioritized",
      truthStatus: "not_assessed",
    };
  });
}

/**
 * Scores every sentence of a transcript for suspicion in one Gemini call.
 * Sentences at or above the threshold are marked verify_claim for the
 * Google-grounded fact-check. Requires GEMINI_API_KEY in the environment.
 */
export async function screen(
  segments: TranscriptSegment[],
  opts: { videoId?: string | null; threshold?: number } = {},
): Promise<ScreenResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const numbered = segments.map((s, i) => `${i}: [${clock(s.start)}] ${s.text.replace(/\s*\n\s*/g, " ")}`);

  const t0 = performance.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt(numbered) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 32768,
        thinkingConfig: THINKING,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status} (screen): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const latencyMs = performance.now() - t0;
  const cand = data.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini hit its output limit while screening; the transcript is too long for one pass");
  }
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no screening result");

  const scores = parseScores(text);
  return {
    status: "completed",
    model: MODEL,
    latencyMs,
    targets: buildTargets(segments, scores, opts.videoId ?? null, threshold),
  };
}
