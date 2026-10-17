/**
 * AWS Lambda entry (Function URL behind CloudFront, see infra/aws/README.md).
 * Secrets come from SSM at cold start and are cached for the container's lifetime.
 */
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { createApp, type Logger } from "./app.js";
import { loadConfig } from "./env.js";
import { type FactCheckFn, factCheckProviders } from "./factcheck/index.js";
import { errorInfo } from "./http.js";
import { type GetTranscript, transcriptProviders } from "./transcripts/index.js";
import { createLogger, warnAboutMocks } from "./logger.js";

const SSM_PREFIX = "/pila/factcheck";

export interface LambdaSecrets {
  readonly originSecret: string;
  /** Comma-separated client tokens. */
  readonly apiTokens: string;
}

export interface LambdaDeps {
  readonly loadSecrets: () => Promise<LambdaSecrets>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  /** Overrides `FACTCHECK_SOURCE` (tests). */
  readonly factCheck?: FactCheckFn | undefined;
  /** Overrides `TRANSCRIPT_SOURCE` (tests). */
  readonly getTranscript?: GetTranscript | undefined;
}

export interface LambdaResponse {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

type AppHandler = (event: LambdaEvent, context?: LambdaContext) => Promise<LambdaResponse>;

export async function loadSsmSecrets(): Promise<LambdaSecrets> {
  const names = ["origin-secret", "api-tokens"].map((n) => `${SSM_PREFIX}/${n}`);
  const out = await new SSMClient({}).send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const value = (name: string) => out.Parameters?.find((p) => p.Name === `${SSM_PREFIX}/${name}`)?.Value;
  const originSecret = value("origin-secret");
  const apiTokens = value("api-tokens");
  if (!originSecret || !apiTokens) {
    const missing = [!originSecret && "origin-secret", !apiTokens && "api-tokens"].filter(Boolean);
    throw new Error(`Missing SSM parameters under ${SSM_PREFIX}: ${missing.join(", ")}`);
  }
  return { originSecret, apiTokens };
}

/** CORS headers too, so a browser client can read the error instead of seeing an opaque failure. */
const unavailable = (): LambdaResponse => ({
  statusCode: 500,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  body: JSON.stringify({ error: { code: "unavailable", message: "The service is starting up or misconfigured.", requestId: "" } }),
});

export function createLambdaHandler(deps: LambdaDeps) {
  let ready: Promise<AppHandler> | undefined;

  async function init(): Promise<AppHandler> {
    const secrets = await deps.loadSecrets();
    // Production rules apply: an empty token list is a config error, so the API fails closed.
    const config = loadConfig({
      ...deps.env,
      NODE_ENV: "production",
      PILA_API_TOKENS: secrets.apiTokens,
      ORIGIN_VERIFY_SECRET: secrets.originSecret,
      TRUST_PROXY: deps.env.TRUST_PROXY ?? "true", // CloudFront sets X-Forwarded-For; the origin check proves it came through
      ALLOWED_ORIGINS: deps.env.ALLOWED_ORIGINS ?? "*", // safe with bearer tokens; the extension's origin varies per install
    });
    const transcripts = deps.getTranscript
      ? { get: deps.getTranscript, source: "custom" }
      : { get: transcriptProviders[config.transcriptSource], source: config.transcriptSource };
    const factCheck = deps.factCheck
      ? { run: deps.factCheck, source: "custom" }
      : { run: factCheckProviders[config.factCheckSource], source: config.factCheckSource };
    warnAboutMocks(deps.logger, { transcripts: transcripts.source, factCheck: factCheck.source });
    return handle(createApp({ config, logger: deps.logger, transcripts, factCheck })) as AppHandler;
  }

  return async (event: LambdaEvent, context?: LambdaContext): Promise<LambdaResponse> => {
    ready ??= init().catch((error: unknown) => {
      ready = undefined; // retry on the next request
      throw error;
    });
    let app: AppHandler;
    try {
      app = await ready;
    } catch (error) {
      deps.logger.error({ error: errorInfo(error) }, "lambda init failed");
      return unavailable();
    }
    return app(event, context);
  };
}

export const handler = createLambdaHandler({ loadSecrets: loadSsmSecrets, env: process.env, logger: createLogger() });
