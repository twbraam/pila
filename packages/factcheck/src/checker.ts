import { mapLimit } from "./concurrency.js";
import { DEFAULT_EXCLUDED_DOMAINS } from "./config.js";
import { type CopyFilter, transcriptCopyFilter } from "./echo.js";
import { CancelledError, InvalidInputError, isFatal } from "./errors.js";
import { createJevClient } from "./jev/client.js";
import { findClaims } from "./jev/detect.js";
import { verifyWithJev } from "./jev/verify.js";
import { type CheckVideoInput, type FactCheckerConfig, parseInput, resolveConfig, type RunOptions } from "./options.js";
import { claimQuery, videoQuery } from "./queries.js";
import { createTavilyClient, rankTrusted, type SearchDepth, toEvidence } from "./tavily.js";
import { detectLanguage, parseTranscript, toSentences } from "./transcript.js";
import type { Claim, ClaimResult, Evidence, Language, Sentence, VideoInfo, VideoReport } from "./types.js";
import { decideLabel } from "./verdict.js";

export interface FactChecker {
  /** Run the whole pipeline for one video. */
  checkVideo(input: CheckVideoInput, options?: RunOptions): Promise<VideoReport>;
  /** Step 2: ask Jev which sentences are checkable claims. */
  findClaims(sentences: readonly Sentence[], options?: RunOptions): Promise<Claim[]>;
  /** Step 3: search Tavily and turn the results into evidence. */
  searchEvidence(query: string, options?: RunOptions): Promise<Evidence[]>;
  /** Step 4: ask Jev what the evidence says about the claim, then apply the verdict rules. */
  verifyClaim(claim: Claim, evidence: readonly Evidence[], options?: RunOptions): Promise<ClaimResult>;
}

interface Counted<T> {
  readonly value: T;
  readonly credits: number;
  readonly tokens: number;
}

interface VideoContext {
  readonly video: VideoInfo | undefined;
  readonly language: Language;
  readonly dropCopies: CopyFilter;
  /** Evidence from the video-level search, offered to every claim. */
  readonly reviews: readonly Evidence[];
}

interface FailedSearch {
  readonly name: string;
  readonly message: string;
}

const dedupeByUrl = (evidence: readonly Evidence[]) =>
  evidence.filter((e, i) => evidence.findIndex((other) => other.url === e.url) === i);

/** a1, b1, a2, b2, ... so neither list can fill every slot on its own. */
const interleave = <T>(a: readonly T[], b: readonly T[]): T[] =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter((x): x is T => x !== undefined);

const describe = (error: unknown): FailedSearch => ({ name: (error as Error).name, message: (error as Error).message });

export function createFactChecker(input: FactCheckerConfig): FactChecker {
  const config = resolveConfig(input);
  const { thresholds, limits } = config;
  const jev = createJevClient({ apiKey: config.typesafeApiKey, model: config.model, fetch: config.fetch, maxRetries: config.maxRetries });
  const tavily = createTavilyClient({ apiKey: config.tavilyApiKey, fetch: config.fetch, retries: config.maxRetries });
  const evidenceOptions = {
    trustedDomains: config.trustedDomains,
    minScore: thresholds.minSearchScore,
    maxSources: limits.maxSourcesPerClaim,
    maxChars: limits.maxEvidenceChars,
  };

  async function search(query: string, depth: SearchDepth, signal?: AbortSignal): Promise<Counted<Evidence[]>> {
    const response = await tavily.search({
      query,
      searchDepth: depth,
      includeDomains: config.trustedDomains,
      excludeDomains: DEFAULT_EXCLUDED_DOMAINS,
      signal,
    });
    return { value: toEvidence(response.results, evidenceOptions), credits: response.credits, tokens: 0 };
  }

  async function verify(claim: Claim, evidence: readonly Evidence[], signal?: AbortSignal): Promise<Counted<ClaimResult>> {
    if (evidence.length === 0) {
      return { value: { claim, label: "insufficient_evidence", confidence: 0, sources: [] }, credits: 0, tokens: 0 };
    }
    const v = await verifyWithJev(jev, claim.text, evidence, signal);
    const decision = decideLabel(v, thresholds);
    const jevVerdicts = { model: v.model, verdict: v.verdict.choice, verdictConfidence: v.verdict.confidence, verdictReversed: v.verdictReversed.choice };
    return { value: { claim, ...decision, sources: v.sources, jev: jevVerdicts }, credits: 0, tokens: v.inputTokens };
  }

  /** Search and verify one claim. Non-fatal errors become a failed claim instead of failing the run. */
  async function checkClaim(claim: Claim, context: VideoContext, signal?: AbortSignal): Promise<Counted<ClaimResult>> {
    let credits = 0;
    try {
      const found = await search(claimQuery(claim.text, context.language, context.video), "advanced", signal);
      credits = found.credits;
      // The claim's own results come first in each pair, so video reviews can't crowd them out.
      const merged = dedupeByUrl(interleave(context.dropCopies(found.value), context.reviews));
      const verified = await verify(claim, rankTrusted(merged, limits.maxSourcesPerClaim), signal);
      return { ...verified, credits };
    } catch (error) {
      if (isFatal(error)) throw error;
      const failed: ClaimResult = { claim, label: "not_sure", confidence: 0, sources: [], error: describe(error) };
      return { value: failed, credits, tokens: 0 };
    }
  }

  /** A failed video search is not fatal: claims are still checked, and the error is reported. */
  async function searchVideo(video: VideoInfo | undefined, language: Language, dropCopies: CopyFilter, signal?: AbortSignal) {
    const query = video ? videoQuery(video, language) : undefined;
    if (!query) return { value: [], credits: 0, tokens: 0 };
    try {
      const found = await search(query, "advanced", signal);
      return { ...found, value: dropCopies(found.value) };
    } catch (error) {
      if (isFatal(error)) throw error;
      return { value: [], credits: 0, tokens: 0, error: describe(error) };
    }
  }

  const detect = (sentences: readonly Sentence[], signal?: AbortSignal) =>
    findClaims(jev, sentences, {
      threshold: thresholds.checkable,
      maxClaims: limits.maxClaims,
      maxPerRequest: limits.maxSentencesPerRequest,
      concurrency: limits.concurrency,
      signal,
    });

  async function checkVideo(raw: CheckVideoInput, options: RunOptions = {}): Promise<VideoReport> {
    const { signal, onProgress } = options;
    const startedAt = Date.now();
    if (signal?.aborted) throw new CancelledError("Fact check was cancelled", { cause: signal.reason });

    const input = parseInput(raw);
    const transcript = parseTranscript(input.transcript);
    const language = input.language ?? detectLanguage(transcript);
    const sentences = toSentences(transcript, language);
    if (sentences.length === 0) throw new InvalidInputError("The transcript has no usable text");
    const dropCopies = transcriptCopyFilter(sentences);
    onProgress?.({ stage: "sentences", done: sentences.length, total: sentences.length });

    const [found, reviews] = await Promise.all([detect(sentences, signal), searchVideo(input.video, language, dropCopies, signal)]);
    onProgress?.({ stage: "claims", done: 1, total: 1 });
    onProgress?.({ stage: "evidence", done: 1, total: 1 });

    let verified = 0;
    const results = await mapLimit(found.claims, limits.concurrency, async (claim) => {
      const context = { video: input.video, language, dropCopies, reviews: reviews.value };
      const result = await checkClaim(claim, context, signal);
      onProgress?.({ stage: "verify", done: ++verified, total: found.claims.length });
      return result;
    });
    onProgress?.({ stage: "done", done: 1, total: 1 });

    return {
      video: input.video ?? {},
      language,
      model: found.model,
      claims: results.map((r) => r.value),
      videoReviews: reviews.value,
      ...("error" in reviews && reviews.error ? { videoSearchError: reviews.error } : {}),
      usage: {
        jevInputTokens: found.inputTokens + results.reduce((sum, r) => sum + r.tokens, 0),
        tavilyCredits: reviews.credits + results.reduce((sum, r) => sum + r.credits, 0),
        durationMs: Date.now() - startedAt,
      },
    };
  }

  return {
    checkVideo,
    findClaims: async (sentences, options = {}) => (await detect(sentences, options.signal)).claims,
    searchEvidence: async (query, options = {}) => (await search(query, "basic", options.signal)).value,
    verifyClaim: async (claim, evidence, options = {}) => (await verify(claim, evidence, options.signal)).value,
  };
}
