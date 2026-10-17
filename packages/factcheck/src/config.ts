/** Pinned so answers don't change when the `jev-latest` alias moves. */
export const DEFAULT_MODEL = "jev-1.13.0";

export interface Thresholds {
  /** Minimum Jev `noul` for a sentence to count as a checkable claim. */
  readonly checkable: number;
  /** Below this verdict confidence the label is `not_sure`. */
  readonly minVerdictConfidence: number;
  /** A trusted source's stance counts only at or above this confidence. */
  readonly trustedStance: number;
  /** Tavily results below this relevance score are dropped. */
  readonly minSearchScore: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  checkable: 0.7,
  minVerdictConfidence: 0.6,
  trustedStance: 0.8,
  minSearchScore: 0.4,
};

export interface Limits {
  readonly maxClaims: number;
  readonly maxSourcesPerClaim: number;
  readonly maxEvidenceChars: number;
  /** Parallel requests per service. */
  readonly concurrency: number;
  /** Sentences per claim-detection request, to stay inside Jev's context limit. */
  readonly maxSentencesPerRequest: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxClaims: 5,
  maxSourcesPerClaim: 5,
  maxEvidenceChars: 1500,
  concurrency: 4,
  maxSentencesPerRequest: 150,
};

export const FACT_CHECK_DOMAINS: readonly string[] = [
  "science.feedback.org",
  "climatefeedback.org",
  "healthfeedback.org",
  "factcheck.org",
  "politifact.com",
  "snopes.com",
  "fullfact.org",
  "reuters.com",
  "apnews.com",
  "afp.com",
  "skepticalscience.com",
  "tfc-taiwan.org.tw",
  "mygopen.com",
  "cofacts.tw",
];

export const SCIENCE_DOMAINS: readonly string[] = ["ipcc.ch", "nasa.gov", "noaa.gov", "who.int"];

/** Searched first, and trusted in the verdict rules. */
export const DEFAULT_TRUSTED_DOMAINS: readonly string[] = [...FACT_CHECK_DOMAINS, ...SCIENCE_DOMAINS];

/** Never used as evidence: the video itself and its reposts. */
export const DEFAULT_EXCLUDED_DOMAINS: readonly string[] = ["youtube.com", "youtu.be"];
