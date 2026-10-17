/**
 * Smoke-test Lambda: proves URL -> CloudFront -> Lambda -> @pila/factcheck works.
 * Replaced by apps/api (Hono) once it ships; see infra/aws/README.md.
 *
 *   GET  /health     -> { success: true, data: { ok: true } }
 *   POST /factcheck  -> body { transcript: Transcript, video?: { title, channel } }
 */
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createFactChecker, type FactChecker, FactCheckError, InvalidInputError, parseContractTranscript } from "../../../packages/factcheck/src/index.ts";

interface UrlEvent {
  readonly rawPath: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: { readonly http: { readonly method: string } };
}

interface UrlResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const SSM_PREFIX = "/pila/factcheck";
/** Leave headroom under the 60 s Lambda and CloudFront limits. */
const RUN_TIMEOUT_MS = 55_000;
const MAX_BODY_BYTES = 2_000_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const reply = (statusCode: number, data: unknown, error: string | null = null): UrlResult => ({
  statusCode,
  headers: { "content-type": "application/json", ...CORS },
  body: JSON.stringify({ success: error === null, data, error }),
});

interface Secrets {
  readonly originSecret: string;
  readonly typesafeApiKey: string;
  readonly tavilyApiKey: string | undefined;
}

let secrets: Promise<Secrets> | undefined;
let checker: FactChecker | undefined;

async function fetchSecrets(): Promise<Secrets> {
  const names = ["origin-secret", "typesafe-api-key", "tavily-api-key"].map((n) => `${SSM_PREFIX}/${n}`);
  const out = await new SSMClient({}).send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const value = (name: string) => out.Parameters?.find((p) => p.Name === `${SSM_PREFIX}/${name}`)?.Value;
  const originSecret = value("origin-secret");
  const typesafeApiKey = value("typesafe-api-key");
  if (!originSecret || !typesafeApiKey) throw new Error(`Missing SSM parameters under ${SSM_PREFIX}`);
  return { originSecret, typesafeApiKey, tavilyApiKey: value("tavily-api-key") };
}

/** Cached per container; a failed load is retried on the next request. */
function loadSecrets(): Promise<Secrets> {
  secrets ??= fetchSecrets().catch((error: unknown) => {
    secrets = undefined;
    throw error;
  });
  return secrets;
}

function parseBody(event: UrlEvent): unknown {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new InvalidInputError("Body too large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidInputError("Body must be JSON");
  }
}

async function runFactCheck(event: UrlEvent, s: Secrets): Promise<UrlResult> {
  const body = parseBody(event) as { transcript?: unknown; video?: { title?: string; channel?: string } };
  const transcript = parseContractTranscript(body.transcript);
  checker ??= createFactChecker({ typesafeApiKey: s.typesafeApiKey, tavilyApiKey: s.tavilyApiKey });
  const results = await checker.factCheck(transcript, {
    video: { title: body.video?.title, channel: body.video?.channel },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  return reply(200, results);
}

function toErrorReply(error: unknown): UrlResult {
  if (error instanceof InvalidInputError) return reply(400, null, error.message);
  console.error(JSON.stringify({ level: "error", name: (error as Error).name, message: (error as Error).message }));
  if (error instanceof FactCheckError) return reply(502, null, `Upstream ${error.service ?? "service"} failed`);
  return reply(500, null, "Internal error");
}

export async function handler(event: UrlEvent): Promise<UrlResult> {
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try {
    const s = await loadSecrets();
    if (event.headers["x-origin-verify"] !== s.originSecret) return reply(403, null, "Forbidden");
    if (method === "GET" && event.rawPath === "/health") return reply(200, { ok: true });
    if (method === "POST" && event.rawPath === "/factcheck") return await runFactCheck(event, s);
    return reply(404, null, "Not found");
  } catch (error) {
    return toErrorReply(error);
  }
}
