import type { LambdaEvent } from "hono/aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { FactCheckItem } from "../src/factcheck/index.js";
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

const secrets: LambdaSecrets = { originSecret: "cf-secret", apiTokens: "ext-token" };

const items: FactCheckItem[] = [{ timestamp: 0, sentence: "The Great Wall is visible from the Moon.", score: 3, sources: ["https://www.snopes.com/x"] }];

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
  const factCheck = vi.fn(async () => items);
  const getTranscript = vi.fn(async (videoId: string) => ({ videoId, segments: [{ text: "The Great Wall is visible from the Moon.", start: 0, duration: 5 }] }));
  const handler = createLambdaHandler({ loadSecrets, env: {}, logger, factCheck, getTranscript });
  return { handler, loadSecrets, factCheck, getTranscript };
};

const origin = { "x-origin-verify": "cf-secret" };

describe("Lambda handler", () => {
  it("serves /health behind the origin check", async () => {
    const { handler } = setup();
    const ok = await handler(event("GET", "/health", origin));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    expect((await handler(event("GET", "/health"))).statusCode).toBe(403);
  });

  it("runs /factcheck with a valid token and returns the items", async () => {
    const { handler, factCheck, getTranscript } = setup();
    const res = await handler(event("POST", "/factcheck", { ...origin, authorization: "Bearer ext-token", "content-type": "application/json" }, { videoId: "dQw4w9WgXcQ" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(items);
    expect(getTranscript).toHaveBeenCalledWith("dQw4w9WgXcQ", expect.anything());
    expect(factCheck).toHaveBeenCalledOnce();
  });

  it("requires the API token from SSM", async () => {
    const { handler } = setup();
    const res = await handler(event("POST", "/factcheck", { ...origin, "content-type": "application/json" }, { videoId: "dQw4w9WgXcQ" }));
    expect(res.statusCode).toBe(401);
  });

  it("labels injected functions as custom", async () => {
    const { handler } = setup();
    const res = await handler(event("POST", "/factcheck", { ...origin, authorization: "Bearer ext-token", "content-type": "application/json" }, { videoId: "dQw4w9WgXcQ" }));
    expect(res.headers?.["x-pila-transcript-source"]).toBe("custom");
    expect(res.headers?.["x-pila-factcheck-source"]).toBe("custom");
  });

  it("uses the mocks by default and warns about them at startup", async () => {
    logger.warn.mockClear();
    const handler = createLambdaHandler({ loadSecrets: async () => secrets, env: {}, logger });
    const res = await handler(event("POST", "/factcheck", { ...origin, authorization: "Bearer ext-token", "content-type": "application/json" }, { videoId: "dQw4w9WgXcQ" }));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["x-pila-transcript-source"]).toBe("mock");
    expect(res.headers?.["x-pila-factcheck-source"]).toBe("mock");
    const warned = JSON.stringify(logger.warn.mock.calls);
    expect(warned).toContain("TRANSCRIPT_SOURCE is mock");
    expect(warned).toContain("FACTCHECK_SOURCE is mock");
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
    expect(JSON.parse(failed.body)).toMatchObject({ error: { code: "unavailable" } });
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

  it("reads the origin secret and API tokens with decryption", async () => {
    ssmSend.mockResolvedValueOnce({ Parameters: [param("origin-secret", "o"), param("api-tokens", "a,b")] });
    expect(await loadSsmSecrets()).toEqual({ originSecret: "o", apiTokens: "a,b" });
    expect(ssmSend.mock.calls[0]?.[0].input).toEqual({
      Names: ["/pila/factcheck/origin-secret", "/pila/factcheck/api-tokens"],
      WithDecryption: true,
    });
  });

  it("names the missing parameters, without any values", async () => {
    ssmSend.mockResolvedValueOnce({ Parameters: [param("unrelated", "secret-value")] });
    const error = await loadSsmSecrets().catch((e: Error) => e);
    expect(String(error)).toContain("origin-secret, api-tokens");
    expect(String(error)).not.toContain("secret-value");
  });
});
