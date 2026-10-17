import { pino } from "pino";
import type { Logger } from "./app.js";

/** JSON logs to stdout. Credentials are redacted in case a header object is ever logged. */
export const createLogger = (level = process.env.LOG_LEVEL ?? "info"): Logger =>
  pino({
    level,
    redact: { paths: ["*.authorization", "*.headers.authorization", "*.apiKey", "*.typesafeApiKey", "*.tavilyApiKey"], censor: "[redacted]" },
  });

/** Say loudly at startup when a stand-in function answers instead of the real one. */
export function warnAboutMocks(logger: Logger, sources: { transcripts: string; factCheck: string }): void {
  if (sources.transcripts === "mock") logger.warn({}, "TRANSCRIPT_SOURCE is mock: every video gets the sample transcript");
  if (sources.factCheck === "mock") logger.warn({}, "FACTCHECK_SOURCE is mock: every video gets the same sample results");
}
