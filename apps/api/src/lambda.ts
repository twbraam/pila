/**
 * AWS Lambda entry (Function URL behind CloudFront, see infra/aws/README.md).
 * Secrets come from SSM at cold start and are cached for the container's lifetime.
 */
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createFactChecker, type FactChecker } from "@pila/factcheck";
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { createApp, type Logger } from "./app.js";
import { type ApiConfig, loadConfig } from "./env.js";
import { createLogger } from "./logger.js";

const SSM_PREFIX = "/pila/factcheck";

export interface LambdaSecrets {
  readonly originSecret: string;
  readonly typesafeApiKey: string;
  readonly tavilyApiKey: string | undefined;
  /** Comma-separated client tokens. */
  readonly apiTokens: string;
}

export interface LambdaDeps {
  readonly loadSecrets: () => Promise<LambdaSecrets>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  readonly createChecker?: ((config: ApiConfig) => Pick<FactChecker, "factCheck">) | undefined;
}

export interface LambdaResponse {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

type AppHandler = (event: LambdaEvent, context?: LambdaContext) => Promise<LambdaResponse>;

export async function loadSsmSecrets(): Promise<LambdaSecrets> {
  const names = ["origin-secret", "typesafe-api-key", "tavily-api-key", "api-tokens"].map((n) => `${SSM_PREFIX}/${n}`);
  const out = await new SSMClient({}).send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const value = (name: string) => out.Parameters?.find((p) => p.Name === `${SSM_PREFIX}/${name}`)?.Value;
  const originSecret = value("origin-secret");
  const typesafeApiKey = value("typesafe-api-key");
  const apiTokens = value("api-tokens");
  const missing = [!originSecret && "origin-secret", !typesafeApiKey && "typesafe-api-key", !apiTokens && "api-tokens"].filter(Boolean);
  if (missing.length > 0 || !originSecret || !typesafeApiKey || !apiTokens) {
    throw new Error(`Missing SSM parameters under ${SSM_PREFIX}: ${missing.join(", ")}`);
  }
  return { originSecret, typesafeApiKey, tavilyApiKey: value("tavily-api-key"), apiTokens };
}

/** CORS headers too, so a browser client can read the error instead of seeing an opaque failure. */
const unavailable = (): LambdaResponse => ({
  statusCode: 500,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  body: JSON.stringify({ success: false, data: null, error: { code: "unavailable", message: "The service is starting up or misconfigured.", requestId: "" } }),
});

export function createLambdaHandler(deps: LambdaDeps) {
  let ready: Promise<AppHandler> | undefined;

  async function init(): Promise<AppHandler> {
    const secrets = await deps.loadSecrets();
    // Production rules apply: an empty token list is a config error, so the API fails closed.
    const config = loadConfig({
      ...deps.env,
      NODE_ENV: "production",
      TYPESAFE_API_KEY: secrets.typesafeApiKey,
      TAVILY_API_KEY: secrets.tavilyApiKey,
      PILA_API_TOKENS: secrets.apiTokens,
      ORIGIN_VERIFY_SECRET: secrets.originSecret,
      TRUST_PROXY: deps.env.TRUST_PROXY ?? "true", // CloudFront sets X-Forwarded-For; the origin check proves it came through
      ALLOWED_ORIGINS: deps.env.ALLOWED_ORIGINS ?? "*", // safe with bearer tokens; the extension's origin varies per install
    });
    const checker = deps.createChecker?.(config) ?? createFactChecker({ typesafeApiKey: config.typesafeApiKey, tavilyApiKey: config.tavilyApiKey });
    return handle(createApp({ checker, config, logger: deps.logger })) as AppHandler;
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
      const { name, message } = error as Error;
      deps.logger.error({ error: { name, message } }, "lambda init failed");
      return unavailable();
    }
    return app(event, context);
  };
}

export const handler = createLambdaHandler({ loadSecrets: loadSsmSecrets, env: process.env, logger: createLogger() });
