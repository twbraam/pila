export type Service = "jev" | "tavily";

interface ErrorDetails {
  readonly service?: Service;
  readonly status?: number;
  readonly cause?: unknown;
}

/** Base class for every error the library throws. Messages never include API keys. */
export class FactCheckError extends Error {
  readonly service: Service | undefined;
  readonly status: number | undefined;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.service = details.service;
    this.status = details.status;
  }
}

/** The transcript, video info, or config is invalid. */
export class InvalidInputError extends FactCheckError {}

/** An API key is missing, wrong, or not allowed (401/403). */
export class AuthError extends FactCheckError {}

/** Too many requests (429), after retries. */
export class RateLimitError extends FactCheckError {}

/** The Tavily plan or credit limit is used up (432/433). */
export class QuotaError extends FactCheckError {}

/** The service failed: 5xx, 529, timeout, network error, or an unexpected response. */
export class UpstreamError extends FactCheckError {}

/** The caller cancelled the run with an `AbortSignal`. */
export class CancelledError extends FactCheckError {}

/** Errors that should stop the whole run instead of failing a single claim. */
export const isFatal = (error: unknown): boolean =>
  error instanceof AuthError ||
  error instanceof InvalidInputError ||
  error instanceof CancelledError ||
  // Every later request would hit the same empty quota.
  error instanceof QuotaError;
