export type Language = "en" | "zh";

/** A `fetch`-compatible function. Injectable for tests and logging. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One caption segment, as returned by YouTube caption tracks and `youtube-transcript-api`. */
export interface TranscriptSegment {
  readonly text: string;
  /** Seconds from the start of the video. */
  readonly start: number;
  /** Seconds the caption stays on screen. */
  readonly duration: number;
}

export interface VideoInfo {
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly channel?: string | undefined;
  readonly url?: string | undefined;
}

export interface Sentence {
  readonly index: number;
  /** Seconds from the start of the video where the sentence begins. */
  readonly start: number;
  readonly text: string;
}

export interface Claim extends Sentence {
  /** Jev's probability that the sentence is a checkable factual claim. */
  readonly checkable: number;
}

export interface Evidence {
  /** Publisher name, e.g. "Science Feedback". */
  readonly source: string;
  /** Page title; may be empty or missing. */
  readonly title?: string | undefined;
  readonly url: string;
  readonly text: string;
  /** True when the domain is on the trusted fact-checker list. */
  readonly trusted: boolean;
  /** Tavily relevance score, 0-1. */
  readonly score: number;
}

export type Stance = "refutes" | "supports" | "not_relevant";
export type Verdict = "false" | "misleading" | "true" | "insufficient_evidence";
export type Label = Verdict | "not_sure";

export interface SourceResult extends Evidence {
  readonly stance: Stance;
  readonly stanceConfidence: number;
  /** The sentence of `text` Jev picked as the source's conclusion about the claim. */
  readonly quote?: string | undefined;
}

export interface JevVerdicts {
  readonly model: string;
  readonly verdict: Verdict;
  readonly verdictConfidence: number;
  readonly verdictReversed: Verdict;
}

export interface ClaimResult {
  readonly claim: Claim;
  readonly label: Label;
  readonly confidence: number;
  readonly sources: readonly SourceResult[];
  /** Raw Jev verdicts, for debugging. Absent when Jev was not called. */
  readonly jev?: JevVerdicts;
  /** Set when this claim failed; the rest of the report is still valid. */
  readonly error?: { readonly name: string; readonly message: string };
}

export interface Usage {
  readonly jevInputTokens: number;
  readonly tavilyCredits: number;
  readonly durationMs: number;
}

export interface VideoReport {
  readonly video: VideoInfo;
  readonly language: Language;
  /** Jev model version that answered, e.g. "jev-1.13.0". */
  readonly model: string;
  readonly claims: readonly ClaimResult[];
  /** Evidence found by searching for the video as a whole. */
  readonly videoReviews: readonly Evidence[];
  /** Set when the video-level search failed; claims were still checked without it. */
  readonly videoSearchError?: { readonly name: string; readonly message: string };
  readonly usage: Usage;
}

export type ProgressStage = "sentences" | "claims" | "evidence" | "verify" | "done";

export interface ProgressEvent {
  readonly stage: ProgressStage;
  readonly done: number;
  readonly total: number;
}
