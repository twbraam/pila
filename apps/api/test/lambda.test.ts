import type { FactCheckOptions, FactCheckResult, Transcript } from "@pila/factcheck";
import type { LambdaEvent } from "hono/aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createLambdaHandler, type LambdaSecrets, loadSsmSecrets } from "../src/lambda.js";

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = ssmSend;
  },
  GetParametersCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const secrets: LambdaSecrets = { originSecret: "cf-secret", typesafeApiKey: "ts", tavilyApiKey: "tvly", apiTokens: "ext-token" };

const transcript: Transcript = {
  videoId: "v1",
  sentences: [{ id: "s1", text: "The Great Wall is visible from the Moon.", startSeconds: 0, endSeconds: 5 }],
};

const result: FactCheckResult = {
  videoId: "v1",
  sentenceId: "s1",
  startSeconds: 0,
  endSeconds: 5,
  sentence: "The Great Wall is visible from the Moon.",
  verdict: "misinformation",
  confidence: 0.9,
  explanation: "Snopes says this claim is false.",
  sources: [{ title: "Snopes", url: "https://www.snopes.com/x" }],
};

/**
 * A Lambda Function URL event (payload v2), as CloudFront forwards it. Cast because Hono types it
 * as an API Gateway v2 event, which has `authorizer`/`authentication` fields Function URLs don't send.
 */
const event = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown): LambdaEvent =>
  ({
  version: "2.0",
  routeKey: "$default",
  rawPath: path,
  rawQueryString: "",
  headers: { host: "abc.lambda-url.us-west-2.on.aws", "x-forwarded-for": "203.0.113.7", ...headers },
  requestContext: {
    accountId: "anonymous",
    apiId: "abc",
    domainName: "abc.lambda-url.us-west-2.on.aws",
    domainPrefix: "abc",
    http: { method, path, protocol: "HTTP/1.1", sourceIp: "130.176.0.1", userAgent: "test" },
    requestId: "req-1",
    routeKey: "$default",
    stage: "$default",
    time: "17/Oct/2026:06:00:00 +0000",
    timeEpoch: 0,
  },
  body: body === undefined ? "" : JSON.stringify(body),
  isBase64Encoded: false,
  }) as unknown as LambdaEvent;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const setup = (loadSecrets = vi.fn(async () => secrets)) => {
  const factCheck = vi.fn(async (_t: Transcript, o?: FactCheckOptions) => {
    o?.onResult?.(result, { claim: { index: 0, start: 0, text: "x", checkable: 1, suspicious: 1 }, label: "false", confidence: 0.9, sources: [] });
    return [result];
  });
  const handler = createLambdaHandler({ loadSecrets, env: {}, logger, createChecker: () => ({ factCheck }) });
  return { handler, loadSecrets, factCheck };
};

const origin = { "x-origin-verify": "cf-secret" };

describe("Lambda handler", () => {
  it("serves /health behind the origin check", async () => {
    const { handler } = setup();
    const ok = await handler(event("GET", "/health", origin));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ success: true, data: { ok: true }, error: null });
    expect((await handler(event("GET", "/health"))).statusCode).toBe(403);
  });

  it("runs /factcheck with a valid token and returns FactCheckResult[]", async () => {
    const { handler, factCheck } = setup();
    const res = await handler(event("POST", "/factcheck", { ...origin, authorization: "Bearer ext-token", "content-type": "application/json" }, { transcript }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: [result], error: null });
    expect(factCheck).toHaveBeenCalledOnce();
  });

  it("requires the API token from SSM", async () => {
    const { handler } = setup();
    const res = await handler(event("POST", "/factcheck", { ...origin, "content-type": "application/json" }, { transcript }));
    expect(res.statusCode).toBe(401);
  });

  it("loads secrets once per container", async () => {
    const { handler, loadSecrets } = setup();
    await handler(event("GET", "/health", origin));
    await handler(event("GET", "/health", origin));
    expect(loadSecrets).toHaveBeenCalledOnce();
  });

  it("returns a safe 500 when secrets can't load, and retries on the next request", async () => {
    const loadSecrets = vi.fn().mockRejectedValueOnce(new Error("AccessDenied: secret details")).mockResolvedValue(secrets);
    const { handler } = setup(loadSecrets);
    const failed = await handler(event("GET", "/health", origin));
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("secret details");
    expect(JSON.parse(failed.body)).toMatchObject({ success: false, data: null, error: { code: "unavailable" } });
    expect(failed.headers?.["access-control-allow-origin"]).toBe("*");
    expect((await handler(event("GET", "/health", origin))).statusCode).toBe(200);
  });

  it("fails closed when the API token parameter is empty", async () => {
    const { handler } = setup(vi.fn(async () => ({ ...secrets, apiTokens: "" })));
    expect((await handler(event("GET", "/health", origin))).statusCode).toBe(500);
  });
});

describe("loadSsmSecrets", () => {
  const param = (name: string, value: string) => ({ Name: `/pila/factcheck/${name}`, Value: value });

  it("reads the four parameters with decryption", async () => {
    ssmSend.mockResolvedValueOnce({
      Parameters: [param("origin-secret", "o"), param("typesafe-api-key", "t"), param("tavily-api-key", "v"), param("api-tokens", "a,b")],
    });
    expect(await loadSsmSecrets()).toEqual({ originSecret: "o", typesafeApiKey: "t", tavilyApiKey: "v", apiTokens: "a,b" });
    expect(ssmSend.mock.calls[0]?.[0].input).toEqual({
      Names: ["/pila/factcheck/origin-secret", "/pila/factcheck/typesafe-api-key", "/pila/factcheck/tavily-api-key", "/pila/factcheck/api-tokens"],
      WithDecryption: true,
    });
  });

  it("names the missing parameters, without any values", async () => {
    ssmSend.mockResolvedValueOnce({ Parameters: [param("typesafe-api-key", "secret-value")] });
    const error = await loadSsmSecrets().catch((e: Error) => e);
    expect(String(error)).toContain("origin-secret, api-tokens");
    expect(String(error)).not.toContain("secret-value");
  });
});
