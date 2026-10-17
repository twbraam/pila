import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError as SdkRateLimitError,
  TypeSafeClient,
  TypeSafeError,
  type Questions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { AuthError, CancelledError, RateLimitError, UpstreamError } from "../errors.js";
import type { Fetch } from "../types.js";

export interface JevClientConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: Fetch | undefined;
  /** Per attempt. Default 10 s (SDK default). */
  readonly timeoutMs?: number | undefined;
  /** Retries for 408, 429, 5xx, and connection errors. Default 2 (SDK default). */
  readonly maxRetries?: number | undefined;
}

export interface JevAnswers {
  readonly model: string;
  /** Unvalidated; callers check each answer's shape. */
  readonly answers: Readonly<Record<string, unknown>>;
  readonly inputTokens: number;
}

export interface JevClient {
  readonly model: string;
  ask(state: SystemOneRequest["state"], questions: Questions, signal?: AbortSignal): Promise<JevAnswers>;
}

function toFactCheckError(error: unknown): unknown {
  const details = (status?: number) => ({ service: "jev", cause: error, ...(status ? { status } : {}) }) as const;
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new AuthError("Jev rejected the API key", details(error.status));
  }
  if (error instanceof SdkRateLimitError) return new RateLimitError("Jev rate limit reached", details(error.status));
  if (error instanceof APIError) return new UpstreamError(`Jev request failed with HTTP ${error.status}`, details(error.status));
  if (error instanceof APIUserAbortError) return new CancelledError("Jev request was cancelled", details());
  if (error instanceof APIConnectionError) return new UpstreamError("Could not reach Jev", details());
  if (error instanceof TypeSafeError) return new UpstreamError(`Jev request was invalid: ${error.message}`, details());
  return error;
}

/** Thin wrapper over the TypeSafe SDK that maps its errors to ours. Runs in service workers and Node. */
export function createJevClient(config: JevClientConfig): JevClient {
  if (!config.apiKey?.trim()) throw new AuthError("Missing Jev API key", { service: "jev" });
  const client = new TypeSafeClient({
    apiKey: config.apiKey,
    defaultModel: config.model,
    compression: false,
    logLevel: "off",
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
    ...(config.maxRetries === undefined ? {} : { retry: { maxRetries: config.maxRetries } }),
  });

  return {
    model: config.model,
    async ask(state, questions, signal) {
      try {
        const result = await client.systemOne({ state, questions, model: config.model }, signal ? { signal } : {});
        return { model: result.model, answers: result.answers, inputTokens: result.usage.input_tokens ?? 0 };
      } catch (error) {
        throw toFactCheckError(error);
      }
    },
  };
}
