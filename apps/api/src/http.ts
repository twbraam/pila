import { AuthError, InvalidInputError, QuotaError, RateLimitError, UpstreamError } from "@pila/factcheck";

/** The response envelope used by every endpoint. */
export type Envelope<T> =
  | { readonly success: true; readonly data: T; readonly error: null }
  | { readonly success: false; readonly data: null; readonly error: ErrorBody };

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

export const ok = <T>(data: T): Envelope<T> => ({ success: true, data, error: null });

export const fail = (error: ErrorBody): Envelope<never> => ({ success: false, data: null, error });

/** An error with an HTTP status and a message that is safe to show clients. */
export class HttpError extends Error {
  constructor(
    /** 499 (client closed the connection) is nginx's convention; nobody reads that response. */
    readonly status: 400 | 401 | 403 | 404 | 413 | 429 | 499 | 500 | 502 | 503 | 504,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    /** The original error, for server logs only. */
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "HttpError";
  }
}

/** Name, message, and library fields of anything thrown, including `undefined` or a string. */
export function errorInfo(error: unknown): { name: string; message: string; service?: string; status?: number } {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  const { name, message } = error;
  const { service, status } = error as Error & { service?: string; status?: number };
  return { name, message, ...(service ? { service } : {}), ...(status ? { status } : {}) };
}

/**
 * Map any error to a client-safe HTTP error. Library messages for bad input are safe to show;
 * everything about upstream services and internals is replaced with a generic message and
 * logged on the server instead.
 */
export function toHttpError(error: unknown, how: { timedOut: boolean; clientGone: boolean }): HttpError {
  if (error instanceof HttpError) return error;
  if (how.timedOut) return new HttpError(504, "timeout", "The fact check took too long. Try again later.");
  if (how.clientGone) return new HttpError(499, "client_closed", "The client closed the connection.");
  if (error instanceof InvalidInputError) return new HttpError(400, "invalid_request", error.message);
  if (error instanceof AuthError) return new HttpError(502, "upstream_misconfigured", "The fact-check service is misconfigured.");
  if (error instanceof QuotaError) return new HttpError(503, "upstream_quota", "The search quota is used up. Try again later.");
  if (error instanceof RateLimitError) return new HttpError(503, "upstream_busy", "The fact-check service is busy. Try again shortly.");
  if (error instanceof UpstreamError) return new HttpError(502, "upstream_error", "A fact-check service failed. Try again later.");
  return new HttpError(500, "internal_error", "Something went wrong.");
}
