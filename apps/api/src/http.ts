/** Error responses are `{ error: ErrorBody }`; successful ones are the payload itself. */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

export const fail = (error: ErrorBody): { readonly error: ErrorBody } => ({ error });

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

/** Name and message of anything thrown, including `undefined` or a string. */
export function errorInfo(error: unknown): { name: string; message: string } {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  return { name: error.name, message: error.message };
}

/**
 * Map any error to a client-safe HTTP error. Timeouts and a gone client win over the error itself
 * (the aborted function throws whatever it throws); anything unexpected is a generic 500.
 */
export function toHttpError(error: unknown, how: { timedOut: boolean; clientGone: boolean }): HttpError {
  if (how.timedOut) return new HttpError(504, "timeout", "The fact check took too long. Try again later.");
  if (how.clientGone) return new HttpError(499, "client_closed", "The client closed the connection.");
  if (error instanceof HttpError) return error;
  return new HttpError(500, "internal_error", "Something went wrong.");
}
