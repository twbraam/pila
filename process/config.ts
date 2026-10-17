export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_SCREEN_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_VERIFY_MODEL = 'gemini-3.8-flash';

export interface ProcessOptions {
  apiKey?: string;
  screenModel?: string;
  verifyModel?: string;
  threshold?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export class ProcessConfigurationError extends Error {
  override name = 'ProcessConfigurationError';
}

/** Resolve environment settings when called, after the entry point loads .env. */
export function resolveOptions(options: ProcessOptions = {}) {
  const apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY)?.trim();
  if (!apiKey) throw new ProcessConfigurationError('Set GEMINI_API_KEY to enable video checks.');
  const screenModel = options.screenModel ?? process.env.SCREEN_MODEL ?? DEFAULT_SCREEN_MODEL;
  const verifyModel = options.verifyModel ?? process.env.FACTCHECK_MODEL ?? DEFAULT_VERIFY_MODEL;
  if (![screenModel, verifyModel].every(model => /^[A-Za-z0-9._-]+$/.test(model))) {
    throw new ProcessConfigurationError('SCREEN_MODEL and FACTCHECK_MODEL must be Gemini model IDs.');
  }
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 5) {
    throw new TypeError('threshold must be between 0 and 5.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be an integer between 1 and 2147483647.');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  return { apiKey, screenModel, verifyModel, threshold, timeoutMs, signal, fetch: options.fetch ?? fetch };
}

export function thinkingConfig(model: string, screening = false) {
  return /^gemini-2\.5/.test(model)
    ? { thinkingBudget: 0 }
    : { thinkingLevel: screening ? 'minimal' : 'low' };
}
