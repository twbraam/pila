export interface ApiConfig {
  readonly typesafeApiKey: string;
  /** Without it, Tavily's rate-limited keyless mode is used. */
  readonly tavilyApiKey: string | undefined;
  readonly host: string;
  readonly port: number;
  /** Bearer tokens accepted from clients. Empty disables auth (development only). */
  readonly apiTokens: readonly string[];
  /** Origins allowed by CORS, e.g. `chrome-extension://<id>`. */
  readonly allowedOrigins: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly cacheTtlMs: number;
  readonly cacheMaxEntries: number;
  readonly requestTimeoutMs: number;
  readonly maxBodyBytes: number;
  /** Read the client IP from proxy headers; only behind a proxy you control. */
  readonly trustProxy: boolean;
  /** How many trusted proxies append to `X-Forwarded-For`; the client is that many entries from the end. */
  readonly trustedProxyHops: number;
  /** When set, every request must carry it in `x-origin-verify` (added by CloudFront). */
  readonly originSecret: string | undefined;
  readonly production: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** Read and validate configuration from environment variables. Fails fast with every problem listed. */
export function loadConfig(env: Env): ApiConfig {
  const problems: string[] = [];

  const number = (name: string, fallback: number, options: { integer?: boolean; min?: number } = {}): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    const integerOk = !options.integer || Number.isInteger(value);
    if (!Number.isFinite(value) || !integerOk || value < (options.min ?? 1)) {
      problems.push(`${name} must be a ${options.integer ? "whole " : ""}number of at least ${options.min ?? 1}`);
      return fallback;
    }
    return value;
  };

  const typesafeApiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!typesafeApiKey) problems.push("TYPESAFE_API_KEY is required");

  const production = env.NODE_ENV === "production";
  const apiTokens = list(env.PILA_API_TOKENS);
  if (production && apiTokens.length === 0) problems.push("PILA_API_TOKENS is required in production");

  const config: ApiConfig = {
    typesafeApiKey,
    tavilyApiKey: env.TAVILY_API_KEY?.trim() || undefined,
    host: env.HOST?.trim() || "0.0.0.0",
    port: number("PORT", 8787, { integer: true }),
    apiTokens,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    rateLimitPerMinute: number("RATE_LIMIT_PER_MINUTE", 20, { integer: true }),
    cacheTtlMs: number("CACHE_TTL_SECONDS", 6 * 60 * 60, { min: 0 }) * 1000,
    cacheMaxEntries: number("CACHE_MAX_ENTRIES", 500, { integer: true }),
    // 55 s: CloudFront and Lambda both cut the connection at 60 s.
    requestTimeoutMs: Math.round(number("REQUEST_TIMEOUT_SECONDS", 55, { min: 0.001 }) * 1000),
    maxBodyBytes: number("MAX_BODY_BYTES", 2_000_000, { integer: true }),
    trustProxy: env.TRUST_PROXY?.trim().toLowerCase() === "true",
    trustedProxyHops: number("TRUSTED_PROXY_HOPS", 1, { integer: true }),
    originSecret: env.ORIGIN_VERIFY_SECRET?.trim() || undefined,
    production,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
