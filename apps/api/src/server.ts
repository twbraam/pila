import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./env.js";
import { factCheckProviders } from "./factcheck/index.js";
import { createLogger, warnAboutMocks } from "./logger.js";
import { transcriptProviders } from "./transcripts/index.js";

const DEV_ENV_FILE = new URL("../../../.env", import.meta.url);
const SHUTDOWN_GRACE_MS = 10_000;

const logger = createLogger();

function main(): void {
  if (process.env.NODE_ENV !== "production" && existsSync(DEV_ENV_FILE)) process.loadEnvFile(DEV_ENV_FILE);
  const config = loadConfig(process.env);
  if (config.apiTokens.length === 0) logger.warn({}, "PILA_API_TOKENS is empty: the API accepts requests without a token");

  const transcripts = { get: transcriptProviders[config.transcriptSource], source: config.transcriptSource };
  const factCheck = { run: factCheckProviders[config.factCheckSource], source: config.factCheckSource };
  warnAboutMocks(logger, { transcripts: transcripts.source, factCheck: factCheck.source });
  const app = createApp({ config, logger, transcripts, factCheck });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
    logger.info({ host: config.host, port: info.port }, "listening"),
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close((error) => {
      if (error) logger.error({ error: { name: error.name, message: error.message } }, "shutdown failed");
      process.exit(error ? 1 : 0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (error) {
  const problems = error instanceof ConfigError ? error.problems : [(error as Error).message];
  logger.error({ problems }, "failed to start");
  process.exitCode = 1;
}
