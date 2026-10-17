import * as z from "zod/mini";
import { AuthError, CancelledError, type FactCheckError, QuotaError, RateLimitError, UpstreamError } from "./errors.js";
import type { Evidence, Fetch } from "./types.js";

const SEARCH_URL = "https://api.tavily.com/search";
const MAX_QUERY_CHARS = 400;
const BACKOFF_MS = 1000;
const MAX_RETRY_AFTER_MS = 5000;

export type SearchDepth = "basic" | "advanced";

export interface TavilySearchOptions {
  readonly query: string;
  readonly searchDepth?: SearchDepth | undefined;
  readonly maxResults?: number | undefined;
  /** Ranked first, but the rest of the web is still searched. */
  readonly includeDomains?: readonly string[] | undefined;
  readonly excludeDomains?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

const resultSchema = z.object({
  title: z._default(z.string(), ""),
  url: z.string(),
  content: z._default(z.string(), ""),
  score: z.number(),
});
const responseSchema = z.object({
  results: z.array(resultSchema),
  usage: z.nullish(z.object({ credits: z.number() })),
  request_id: z.nullish(z.string()),
});

export type TavilyResult = z.infer<typeof resultSchema>;

export interface TavilySearchResponse {
  readonly results: readonly TavilyResult[];
  readonly credits: number;
  readonly requestId: string | undefined;
}

export interface TavilyClientConfig {
  /** Omit to use Tavily's rate-limited keyless mode. */
  readonly apiKey?: string | undefined;
  readonly fetch?: Fetch | undefined;
  /** Retries for 429 and 5xx. Default 1. */
  readonly retries?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

export interface TavilyClient {
  search(options: TavilySearchOptions): Promise<TavilySearchResponse>;
}

/** Resolves after `ms`, or early when `signal` aborts. */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

const cancelled = (cause?: unknown) => new CancelledError("Tavily search was cancelled", { service: "tavily", cause });

function errorForStatus(status: number): FactCheckError {
  const details = { service: "tavily", status } as const;
  if (status === 401 || status === 403) return new AuthError("Tavily rejected the API key", details);
  if (status === 429) return new RateLimitError("Tavily rate limit reached", details);
  if (status === 432 || status === 433) return new QuotaError("Tavily plan or credit limit reached", details);
  return new UpstreamError(`Tavily search failed with HTTP ${status}`, details);
}

const isRetryable = (status: number) => status === 429 || status >= 500;

function retryDelay(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return BACKOFF_MS * 2 ** attempt;
}

export function createTavilyClient(config: TavilyClientConfig): TavilyClient {
  const fetchFn: Fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const retries = config.retries ?? 1;
  const sleep = config.sleep ?? defaultSleep;
  const auth: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { "X-Tavily-Access-Mode": "keyless" };

  async function send(options: TavilySearchOptions): Promise<Response> {
    const depth = options.searchDepth ?? "basic";
    const body = {
      query: options.query.slice(0, MAX_QUERY_CHARS),
      search_depth: depth,
      max_results: options.maxResults ?? 5,
      chunks_per_source: 3,
      include_answer: false,
      topic: "general",
      ...(options.includeDomains?.length
        ? { include_domains: options.includeDomains, include_domains_mode: "prefer" }
        : {}),
      ...(options.excludeDomains?.length ? { exclude_domains: options.excludeDomains } : {}),
    };
    try {
      return await fetchFn(SEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted || (error as Error)?.name === "AbortError") throw cancelled(error);
      throw new UpstreamError("Could not reach Tavily", { service: "tavily", cause: error });
    }
  }

  async function search(options: TavilySearchOptions): Promise<TavilySearchResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await send(options);
      if (response.ok) return parse(response, options.searchDepth ?? "basic", options.signal);
      if (!isRetryable(response.status) || attempt >= retries) throw errorForStatus(response.status);
      await sleep(retryDelay(response, attempt), options.signal);
      if (options.signal?.aborted) throw cancelled(options.signal.reason);
    }
  }

  return { search };
}

async function parse(response: Response, depth: SearchDepth, signal?: AbortSignal): Promise<TavilySearchResponse> {
  const body: unknown = await response.json().catch((error: unknown) => {
    if (signal?.aborted || (error as Error)?.name === "AbortError") throw cancelled(error);
    return undefined;
  });
  if (signal?.aborted) throw cancelled(signal.reason);
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new UpstreamError("Tavily returned an unexpected response", { service: "tavily", status: response.status });
  }
  return {
    results: parsed.data.results,
    credits: parsed.data.usage?.credits ?? (depth === "advanced" ? 2 : 1),
    requestId: parsed.data.request_id ?? undefined,
  };
}

export interface EvidenceOptions {
  readonly trustedDomains: readonly string[];
  readonly minScore: number;
  readonly maxSources: number;
  readonly maxChars: number;
}

const httpsUrl = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

const hostname = (url: URL) => url.hostname.replace(/^www\./, "");

const isTrusted = (url: URL, domains: readonly string[]) =>
  domains.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));

/** "Some headline - Science Feedback" -> "Science Feedback"; otherwise the hostname. */
function publisher(title: string, url: URL): string {
  const suffix = title.split(/ [-|–] /).at(-1)?.trim();
  return suffix && suffix !== title.trim() && suffix.length <= 40 ? suffix : hostname(url);
}

const normalizeTitle = (title: string) => title.toLowerCase().replace(/\s+/g, " ").trim();

/** Filter, de-duplicate, and rank search results into evidence for Jev. Trusted sources come first. */
export function toEvidence(results: readonly TavilyResult[], options: EvidenceOptions): Evidence[] {
  const seen = new Set<string>();
  const evidence = results.flatMap((result): Evidence[] => {
    const url = httpsUrl(result.url);
    if (!url || result.score < options.minScore) return [];
    const key = normalizeTitle(result.title) || url.href;
    if (seen.has(key) || seen.has(url.href)) return [];
    seen.add(key).add(url.href);
    return [
      {
        source: publisher(result.title, url),
        url: url.href,
        text: result.content.replace(/\s+/g, " ").trim().slice(0, options.maxChars),
        trusted: isTrusted(url, options.trustedDomains),
        score: result.score,
      },
    ];
  });
  return rankTrusted(evidence, options.maxSources);
}

/** Trusted sources first, otherwise in the given order, at most `max`. */
export const rankTrusted = (evidence: readonly Evidence[], max: number): Evidence[] =>
  [...evidence.filter((e) => e.trusted), ...evidence.filter((e) => !e.trusted)].slice(0, max);
