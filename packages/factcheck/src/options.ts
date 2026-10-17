import * as z from "zod/mini";
import { DEFAULT_LIMITS, DEFAULT_MODEL, DEFAULT_THRESHOLDS, DEFAULT_TRUSTED_DOMAINS, type Limits, type Thresholds } from "./config.js";
import { InvalidInputError } from "./errors.js";
import type { Fetch, Language, ProgressEvent, TranscriptSegment, VideoInfo } from "./types.js";

type Overrides<T> = { readonly [K in keyof T]?: T[K] | undefined };

export interface FactCheckerConfig {
  /** TypeSafe (Jev) API key. Required. */
  readonly typesafeApiKey: string;
  /** Tavily API key. Omit to use Tavily's rate-limited keyless mode (fine for local tests). */
  readonly tavilyApiKey?: string | undefined;
  /** Jev model ID. Default: a pinned version, see `DEFAULT_MODEL`. */
  readonly model?: string | undefined;
  readonly fetch?: Fetch | undefined;
  /** Retries per request for rate limits and server errors. Default: Jev 2, Tavily 1. */
  readonly maxRetries?: number | undefined;
  /** Fact-checker and science domains: searched first and trusted in the verdict rules. */
  readonly trustedDomains?: readonly string[] | undefined;
  readonly thresholds?: Overrides<Thresholds> | undefined;
  readonly limits?: Overrides<Limits> | undefined;
}

export interface ResolvedConfig {
  readonly typesafeApiKey: string;
  readonly tavilyApiKey: string | undefined;
  readonly model: string;
  readonly fetch: Fetch | undefined;
  readonly maxRetries: number | undefined;
  readonly trustedDomains: readonly string[];
  readonly thresholds: Thresholds;
  readonly limits: Limits;
}

const probability = z.number().check(z.minimum(0), z.maximum(1));
const count = (min: number, max: number) => z.int().check(z.minimum(min), z.maximum(max));
const nonEmpty = () => z.string().check(z.minLength(1));

const configSchema = z.object({
  typesafeApiKey: z.string(),
  tavilyApiKey: z.optional(z.string()),
  model: z.optional(nonEmpty()),
  fetch: z.optional(z.custom<Fetch>((v) => typeof v === "function", "fetch must be a function")),
  maxRetries: z.optional(count(0, 5)),
  trustedDomains: z.optional(z.array(nonEmpty())),
  thresholds: z.optional(
    z.partial(z.object({ checkable: probability, minVerdictConfidence: probability, trustedStance: probability, minSearchScore: probability })),
  ),
  limits: z.optional(
    z.partial(
      z.object({
        maxClaims: count(1, 20),
        maxSourcesPerClaim: count(1, 10),
        maxEvidenceChars: count(200, 5000),
        concurrency: count(1, 10),
        maxSentencesPerRequest: count(10, 500),
      }),
    ),
  ),
});

const parseOrThrow = <S extends z.ZodMiniType>(schema: S, input: unknown, what: string): z.infer<S> => {
  const result = schema.safeParse(input);
  if (!result.success) throw new InvalidInputError(`Invalid ${what}: ${z.prettifyError(result.error)}`);
  return result.data;
};

/** Overrides win only where they are defined, so `{ maxClaims: undefined }` keeps the default. */
const withDefaults = <T extends object>(defaults: T, overrides: Overrides<T> = {}): T => ({
  ...defaults,
  ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
});

export function resolveConfig(input: FactCheckerConfig): ResolvedConfig {
  const config = parseOrThrow(configSchema, input, "fact checker config");
  return {
    typesafeApiKey: config.typesafeApiKey,
    tavilyApiKey: config.tavilyApiKey?.trim() || undefined,
    model: config.model ?? DEFAULT_MODEL,
    fetch: config.fetch,
    maxRetries: config.maxRetries,
    trustedDomains: config.trustedDomains ?? DEFAULT_TRUSTED_DOMAINS,
    thresholds: withDefaults(DEFAULT_THRESHOLDS, config.thresholds),
    limits: withDefaults(DEFAULT_LIMITS, config.limits),
  };
}

export interface CheckVideoInput {
  readonly video?: VideoInfo | undefined;
  readonly transcript: readonly TranscriptSegment[];
  /** Detected from the transcript when omitted (English first). */
  readonly language?: Language | undefined;
}

export interface RunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
}

const text = (max: number) => z.optional(z.string().check(z.maxLength(max)));
const inputSchema = z.object({
  video: z.optional(z.object({ id: text(64), title: text(500), channel: text(200), url: text(2048) })),
  transcript: z.unknown(),
  language: z.optional(z.enum(["en", "zh"])),
});

export function parseInput(input: unknown) {
  return parseOrThrow(inputSchema, input, "video input");
}
