import { pino } from "pino";
import type { Logger } from "./app.js";

/** JSON logs to stdout. Credentials are redacted in case a header object is ever logged. */
export const createLogger = (level = process.env.LOG_LEVEL ?? "info"): Logger =>
  pino({
    level,
    redact: { paths: ["*.authorization", "*.headers.authorization", "*.apiKey", "*.typesafeApiKey", "*.tavilyApiKey"], censor: "[redacted]" },
  });
