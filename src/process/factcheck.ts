import type { TranscriptSegment } from "../extract/transcript.js";

export const MODEL = process.env.FACTCHECK_MODEL ?? "gemini-3.8-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Keeps reasoning as low as the model allows, for lower latency and cost.
 * 2.5 models can turn thinking off with a zero budget. Gemini 3.x models use
 * thinking levels instead and 3.8 Flash cannot go below "low", so thinking
 * stays on at its lowest level there.
 */
export const THINKING_MODE = /^gemini-2\.5/.test(MODEL) ? "off" : "low";
export const NO_THINKING = {
  thinkingConfig: THINKING_MODE === "off" ? { thinkingBudget: 0 } : { thinkingLevel: "low" },
};

/**
 * truth     = grounding sources support the line
 * not_truth = grounding sources contradict the line
 * unchecked = no checkable claim, or no source either way; never reported as false
 */
export const VERDICTS = ["truth", "not_truth", "unchecked"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const SENTIMENTS = ["positive", "negative", "neutral", "mixed"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface Source {
  title: string;
  uri: string;
}

export interface CheckedSegment extends TranscriptSegment {
  verdict: Verdict;
  reason: string;
  /** Sources Google Search grounding tied to this line. */
  sources: Source[];
}

/** What the whole video is trying to deliver, read from the full transcript. */
export interface Overview {
  mainMessage: string;
  summary: string;
  sentiment: Sentiment;
  tone: string;
  keyClaims: string[];
}

export interface FactCheckResult {
  model: string;
  /** "off" (2.5 models) or "low" (3.x models, which cannot turn thinking fully off). */
  thinking: string;
  overview: Overview;
  /** Whether the video's main message holds up given the grounded findings. */
  messageAssessment: string;
  segments: CheckedSegment[];
  /** Every distinct source used across the whole transcript. */
  sources: Source[];
  latency: {
    /** Stage 0: plain Gemini call that reads the whole text for message and sentiment. */
    overviewMs: number;
    /** Stage 1: the Google-grounded call (search + writing the notes). */
    groundingMs: number;
    /** Stage 2: the plain Gemini call (no tools) that issues the verdicts. */
    judgingMs: number;
    totalMs: number;
  };
}

interface Grounding {
  groundingChunks?: { web?: { uri?: string; title?: string } }[];
  groundingSupports?: {
    segment?: { startIndex?: number; endIndex?: number; text?: string };
    groundingChunkIndices?: number[];
  }[];
}

type Notes = Map<number, { notes: string; sources: Source[] }>;

interface Candidate {
  content?: { parts?: { text?: string }[] };
  groundingMetadata?: Grounding;
  finishReason?: string;
}

export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export async function generate(
  body: object,
  apiKey: string,
  stage: string,
): Promise<{ cand: Candidate; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status} (${stage}): ${await res.text()}`);
  }
  const data = (await res.json()) as { candidates?: Candidate[] };
  const ms = performance.now() - t0;
  const cand = data.candidates?.[0];
  if (!cand) throw new Error(`Gemini returned no candidates (${stage})`);
  if (cand.finishReason === "MAX_TOKENS") {
    throw new Error(`Gemini hit its output limit during ${stage}; the transcript is too long for one pass`);
  }
  return { cand, ms };
}

export const textOf = (c: Candidate) => (c.content?.parts ?? []).map((p) => p.text ?? "").join("");

const OVERVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    mainMessage: { type: "STRING" },
    summary: { type: "STRING" },
    sentiment: { type: "STRING", enum: [...SENTIMENTS] },
    tone: { type: "STRING" },
    keyClaims: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["mainMessage", "summary", "sentiment", "tone", "keyClaims"],
};

const JUDGING_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER" },
          verdict: { type: "STRING", enum: [...VERDICTS] },
          reason: { type: "STRING" },
        },
        required: ["id", "verdict", "reason"],
      },
    },
    messageAssessment: { type: "STRING" },
  },
  required: ["lines", "messageAssessment"],
};

function overviewPrompt(numbered: string[]): string {
  return `Below is the full transcript of a video (speech-to-text), one numbered line each with its timestamp. Read all of it and describe what the video is trying to deliver.

Return JSON with:
- mainMessage: the central point or argument the video wants the viewer to take away (one or two sentences)
- summary: a three to five sentence summary of the whole video
- sentiment: the overall sentiment toward its subject: positive, negative, neutral or mixed
- tone: the speaker's tone and intent in a few words (for example persuasive, alarmist, educational)
- keyClaims: the three to six factual claims the main message depends on

Describe only what the video says. Do not judge whether it is true.

Transcript:
${numbered.join("\n")}`;
}

function groundingPrompt(numbered: string[], overview: Overview): string {
  const today = new Date().toISOString().slice(0, 10);
  const key = overview.keyClaims.map((c) => `- ${c}`).join("\n");
  return `Today's date is ${today}. Below is the full transcript of a video (speech-to-text, so judge the intended meaning). Each line is "<id>: [timestamp] text". Use the whole transcript as context for each line.

The video's main message is: "${overview.mainMessage}"
Its key claims are:
${key}

Use Google Search to check the factual claims. Check the key claims first, then every other line with a checkable factual claim. For each such line, write ONE line in exactly this form:
<id>: <what reliable sources say about the claim, in one or two sentences>
If you find no reliable source either way, write: <id>: NO SOURCES FOUND
Skip lines with no factual claim (opinion, greeting, filler). Output nothing else.

Transcript:
${numbered.join("\n")}`;
}

function judgingPrompt(numbered: string[], notes: Notes, overview: Overview): string {
  const findings = [...notes].map(([id, n]) => `${id}: ${n.notes}`).join("\n");
  return `You are a fact-checker. For each numbered transcript line, issue a verdict using ONLY the search findings below.

Verdicts:
- truth: the findings support the claim.
- not_truth: the findings contradict the claim, or show it is false, misleading or outdated.
- unchecked: the findings are "NO SOURCES FOUND" or inconclusive, or the line has no checkable fact. Use "" as the reason.
Only use not_truth when the findings clearly contradict the line. When unsure, use unchecked.

Give each reason in one or two sentences stating the specific facts from the findings that support or contradict the line (names, numbers, dates), not a generic "sources agree".

Also write messageAssessment: two or three sentences on whether the video's main message ("${overview.mainMessage}") holds up given the findings. Name the not_truth lines (by id) that weaken it, or say that nothing found contradicts it. Use only the findings.

Transcript:
${numbered.join("\n")}

Search findings:
${findings}`;
}

/** Reads the overview JSON. Exported so it can be tested without calling the API. */
export function parseOverview(text: string): Overview {
  const o = JSON.parse(text) as Partial<Overview>;
  return {
    mainMessage: (o.mainMessage ?? "").trim(),
    summary: (o.summary ?? "").trim(),
    sentiment: SENTIMENTS.includes(o.sentiment as Sentiment) ? (o.sentiment as Sentiment) : "neutral",
    tone: (o.tone ?? "").trim(),
    keyClaims: Array.isArray(o.keyClaims) ? o.keyClaims.map((c) => String(c).trim()).filter(Boolean) : [],
  };
}

/**
 * Reads the stage 1 notes (one "<id>: ..." line each) and attaches the
 * grounding sources whose supported text falls on each line.
 * Exported so it can be tested without calling the API.
 */
export function parseNotes(text: string, grounding: Grounding = {}): Notes {
  const chunks = grounding.groundingChunks ?? [];

  const items: {
    id: number;
    notes: string;
    start: number;
    end: number;
    raw: string;
    sources: Map<string, Source>;
  }[] = [];

  let offset = 0;
  for (const raw of text.split("\n")) {
    const start = offset;
    offset += raw.length + 1;
    const m = raw.match(/^\s*(\d+)\s*:\s*(.+)$/);
    if (!m) continue;
    items.push({ id: Number(m[1]), notes: m[2].trim(), start, end: start + raw.length, raw, sources: new Map() });
  }

  for (const s of grounding.groundingSupports ?? []) {
    const seg = s.segment;
    if (!seg) continue;
    // Gemini omits startIndex when it is 0.
    const at = seg.startIndex ?? 0;
    // Trust the offsets only if they really point at the quoted text;
    // otherwise find the line that contains that text.
    const offsetsOk = seg.text === undefined || text.slice(at, seg.endIndex) === seg.text;
    const item = offsetsOk
      ? items.find((i) => at >= i.start && at < i.end)
      : items.find((i) => i.raw.includes(seg.text!));
    if (!item) continue;
    for (const idx of s.groundingChunkIndices ?? []) {
      const web = chunks[idx]?.web;
      if (web?.uri) item.sources.set(web.uri, { title: web.title ?? web.uri, uri: web.uri });
    }
  }

  return new Map(items.map((i) => [i.id, { notes: i.notes, sources: [...i.sources.values()] }]));
}

/** Reads the judging JSON. Exported so it can be tested without calling the API. */
export function parseJudging(text: string): {
  verdicts: Map<number, { verdict: Verdict; reason: string }>;
  messageAssessment: string;
} {
  const o = JSON.parse(text) as {
    lines?: { id: number; verdict: string; reason?: string }[];
    messageAssessment?: string;
  };
  const verdicts = new Map<number, { verdict: Verdict; reason: string }>();
  for (const l of o.lines ?? []) {
    if (typeof l.id !== "number") continue;
    verdicts.set(l.id, {
      verdict: VERDICTS.includes(l.verdict as Verdict) ? (l.verdict as Verdict) : "unchecked",
      reason: (l.reason ?? "").trim(),
    });
  }
  return { verdicts, messageAssessment: (o.messageAssessment ?? "").trim() };
}

/**
 * Fact-checks a whole transcript in three Gemini calls, so each can be timed:
 *   0. Overview:  reads the full text for the main message, sentiment and key claims.
 *   1. Grounding: flash-lite + the google_search tool checks the claims and gathers sources.
 *   2. Judging:   a plain call (no tools) turns the findings into verdicts and assesses the message.
 * The whole transcript goes in every call, so each line is judged in the context of the video.
 * Requires GEMINI_API_KEY in the environment.
 */
export async function factCheck(segments: TranscriptSegment[]): Promise<FactCheckResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const numbered = segments.map((s, i) => `${i}: [${clock(s.start)}] ${s.text.replace(/\s*\n\s*/g, " ")}`);
  const started = performance.now();
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  // Stage 0: overview of the whole text.
  const o = await generate(
    {
      contents: [{ parts: [{ text: overviewPrompt(numbered) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
        ...NO_THINKING,
        responseMimeType: "application/json",
        responseSchema: OVERVIEW_SCHEMA,
      },
    },
    apiKey,
    "overview",
  );
  const overview = parseOverview(textOf(o.cand));
  console.error(`Overview: ${sec(o.ms)} (sentiment: ${overview.sentiment})`);

  // Stage 1: Google grounding.
  const g = await generate(
    {
      contents: [{ parts: [{ text: groundingPrompt(numbered, overview) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0, maxOutputTokens: 32768, ...NO_THINKING },
    },
    apiKey,
    "grounding",
  );
  const grounding = g.cand.groundingMetadata ?? {};
  const notes = parseNotes(textOf(g.cand), grounding);
  const allSources = new Map<string, Source>();
  for (const c of grounding.groundingChunks ?? []) {
    if (c.web?.uri) allSources.set(c.web.uri, { title: c.web.title ?? c.web.uri, uri: c.web.uri });
  }
  console.error(`Grounding: ${sec(g.ms)} (${notes.size} claims checked, ${allSources.size} sources)`);

  // Stage 2: Gemini judging. Skipped when no line had a claim to judge.
  let verdicts = new Map<number, { verdict: Verdict; reason: string }>();
  let messageAssessment = "No checkable factual claims were found in the transcript.";
  let judgingMs = 0;
  if (notes.size > 0) {
    const j = await generate(
      {
        contents: [{ parts: [{ text: judgingPrompt(numbered, notes, overview) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 32768,
          ...NO_THINKING,
          responseMimeType: "application/json",
          responseSchema: JUDGING_SCHEMA,
        },
      },
      apiKey,
      "judging",
    );
    ({ verdicts, messageAssessment } = parseJudging(textOf(j.cand)));
    judgingMs = j.ms;
  }
  console.error(`Judging: ${sec(judgingMs)}`);

  const checked = segments.map((seg, id): CheckedSegment => {
    const v = verdicts.get(id);
    const sources = notes.get(id)?.sources ?? [];
    let verdict: Verdict = v?.verdict ?? "unchecked";
    let reason = v?.reason ?? "";
    // A verdict is only trusted if grounding backs it. Without a source the
    // model is judging from memory, which is not fact-checking.
    if (verdict !== "unchecked" && sources.length === 0) {
      reason = `No grounding source found, so this could not be verified. Model's unsupported judgement (${verdict}): ${reason}`;
      verdict = "unchecked";
    }
    return { ...seg, verdict, reason, sources };
  });

  return {
    model: MODEL,
    thinking: THINKING_MODE,
    overview,
    messageAssessment,
    segments: checked,
    sources: [...allSources.values()],
    latency: {
      overviewMs: o.ms,
      groundingMs: g.ms,
      judgingMs,
      totalMs: performance.now() - started,
    },
  };
}
