export { createFactChecker, type FactChecker } from "./checker.js";
export type { CheckVideoInput, FactCheckerConfig, FactCheckOptions, RunOptions } from "./options.js";
export {
  parseContractTranscript,
  segmentsToTranscript,
  type FactCheckResult,
  type FactCheckVerdict,
  type SubtitleSentence,
  type Transcript,
} from "./contract.js";
export { toFactCheckResult } from "./result.js";
export { detectLanguage, parseTranscript, toSentences, toTimedSentences } from "./transcript.js";
export { claimQuery, videoQuery } from "./queries.js";
export { decideLabel } from "./verdict.js";
export { buildDetectionRequest } from "./jev/detect.js";
export { buildVerificationRequest, splitEvidenceSentences, STANCE_CRITERIA, VERDICT_CRITERIA } from "./jev/verify.js";
export { dropTranscriptCopies } from "./echo.js";
export {
  DEFAULT_EXCLUDED_DOMAINS,
  DEFAULT_LIMITS,
  DEFAULT_MODEL,
  DEFAULT_THRESHOLDS,
  DEFAULT_TRUSTED_DOMAINS,
  FACT_CHECK_DOMAINS,
  SCIENCE_DOMAINS,
  type Limits,
  type Thresholds,
} from "./config.js";
export {
  AuthError,
  CancelledError,
  FactCheckError,
  InvalidInputError,
  QuotaError,
  RateLimitError,
  UpstreamError,
  type Service,
} from "./errors.js";
export type * from "./types.js";
