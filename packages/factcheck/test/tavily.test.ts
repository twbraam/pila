import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TRUSTED_DOMAINS } from "../src/config.js";
import { AuthError, CancelledError, QuotaError, RateLimitError, UpstreamError } from "../src/errors.js";
import { createTavilyClient, toEvidence, type TavilyResult } from "../src/tavily.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tavily-lindzen.json", import.meta.url), "utf8"));
const TAVILY = "https://api.tavily.com/search";
const noSleep = async () => {};

describe("createTavilyClient.search", () => {
  it("sends the key as a bearer token and the search options as JSON", async () => {
    const { fetch, calls } = fakeFetch({ [TAVILY]: () => json(fixture) });
    const tavily = createTavilyClient({ apiKey: "tvly-test", fetch });

    const response = await tavily.search({
      query: "Lindzen PragerU fact check",
      searchDepth: "advanced",
      includeDomains: ["science.feedback.org"],
      excludeDomains: ["youtube.com"],
    });

    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tvly-test");
    expect(calls[0]?.body).toMatchObject({ exclude_domains: ["youtube.com"] });
    expect(calls[0]?.body).toMatchObject({
      query: "Lindzen PragerU fact check",
      search_depth: "advanced",
      max_results: 5,
      chunks_per_source: 3,
      include_domains: ["science.feedback.org"],
      include_domains_mode: "prefer",
      include_answer: false,
    });
    expect(response.results).toHaveLength(5);
    expect(response.credits).toBe(2);
  });

  it("uses keyless mode when no key is given", async () => {
    const { fetch, calls } = fakeFetch({ [TAVILY]: () => json(fixture) });
    await createTavilyClient({ fetch }).search({ query: "q" });
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.headers.get("x-tavily-access-mode")).toBe("keyless");
  });

  it("reads credits from the response when present", async () => {
    const { fetch } = fakeFetch({ [TAVILY]: () => json({ ...fixture, usage: { credits: 7 } }) });
    expect((await createTavilyClient({ fetch }).search({ query: "q" })).credits).toBe(7);
  });

  it("caps the query at 400 characters", async () => {
    const { fetch, calls } = fakeFetch({ [TAVILY]: () => json(fixture) });
    await createTavilyClient({ fetch }).search({ query: "x".repeat(500) });
    expect((calls[0]?.body as { query: string }).query).toHaveLength(400);
  });

  it.each([
    [401, AuthError],
    [403, AuthError],
    [429, RateLimitError],
    [432, QuotaError],
    [433, QuotaError],
    [500, UpstreamError],
    [400, UpstreamError],
  ])("maps HTTP %i to %o", async (status, ErrorClass) => {
    const { fetch } = fakeFetch({ [TAVILY]: () => json({ detail: { error: "nope" } }, status) });
    const search = createTavilyClient({ fetch, retries: 0 }).search({ query: "q" });
    await expect(search).rejects.toBeInstanceOf(ErrorClass);
    await expect(search).rejects.toMatchObject({ service: "tavily", status });
  });

  it("does not put the API key in error messages", async () => {
    const { fetch } = fakeFetch({ [TAVILY]: () => json({ detail: { error: "bad key" } }, 401) });
    const error = await createTavilyClient({ apiKey: "tvly-secret", fetch }).search({ query: "q" }).catch((e) => e);
    expect(String(error.message)).not.toContain("tvly-secret");
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    let attempts = 0;
    const { fetch } = fakeFetch({ [TAVILY]: () => (++attempts < 3 ? json({}, attempts === 1 ? 429 : 503) : json(fixture)) });
    const response = await createTavilyClient({ fetch, retries: 2, sleep: noSleep }).search({ query: "q" });
    expect(attempts).toBe(3);
    expect(response.results).toHaveLength(5);
  });

  it("does not retry auth errors", async () => {
    let attempts = 0;
    const { fetch } = fakeFetch({ [TAVILY]: () => (attempts++, json({}, 401)) });
    await expect(createTavilyClient({ fetch, retries: 2, sleep: noSleep }).search({ query: "q" })).rejects.toBeInstanceOf(AuthError);
    expect(attempts).toBe(1);
  });

  it("maps network failures to UpstreamError", async () => {
    const { fetch } = fakeFetch({});
    await expect(createTavilyClient({ fetch, retries: 0 }).search({ query: "q" })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects a response with an unexpected shape", async () => {
    const { fetch } = fakeFetch({ [TAVILY]: () => json({ results: "nope" }) });
    await expect(createTavilyClient({ fetch }).search({ query: "q" })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("maps an abort while reading the body to CancelledError", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch({
      [TAVILY]: () => {
        controller.abort();
        return new Response("{not json", { status: 200 });
      },
    });
    const search = createTavilyClient({ fetch }).search({ query: "q", signal: controller.signal });
    await expect(search).rejects.toBeInstanceOf(CancelledError);
  });

  it("stops waiting for a retry as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch({ [TAVILY]: () => json({}, 429, { "retry-after": "5" }) });
    const started = Date.now();
    const search = createTavilyClient({ fetch, retries: 1 }).search({ query: "q", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(search).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("maps an aborted signal to CancelledError", async () => {
    const { fetch } = fakeFetch({ [TAVILY]: () => json(fixture) });
    const controller = new AbortController();
    controller.abort();
    const search = createTavilyClient({ fetch }).search({ query: "q", signal: controller.signal });
    await expect(search).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("toEvidence", () => {
  const options = { trustedDomains: DEFAULT_TRUSTED_DOMAINS, minScore: 0.5, maxSources: 5, maxChars: 1500 };
  const results: TavilyResult[] = fixture.results;

  it("drops duplicates, keeps trusted sources first, and names the publisher", () => {
    const evidence = toEvidence(results, options);
    expect(evidence.map((e) => [e.source, e.trusted])).toEqual([
      ["Science Feedback", true],
      ["Science Feedback", true],
      ["Science Feedback", true],
      ["facebook.com", false],
    ]);
    expect(evidence[0]?.url).toContain("science.feedback.org/review/video-from-prageru");
  });

  it("caps text length", () => {
    for (const e of toEvidence(results, options)) expect(e.text.length).toBeLessThanOrEqual(1500);
  });

  it("drops low-score results", () => {
    expect(toEvidence(results, { ...options, minScore: 0.8 })).toHaveLength(2);
  });

  it("limits the number of sources", () => {
    expect(toEvidence(results, { ...options, maxSources: 2 })).toHaveLength(2);
  });

  it("drops results that are not https links", () => {
    const unsafe = [{ title: "x", url: "javascript:alert(1)", content: "x", score: 0.9 }];
    expect(toEvidence(unsafe, options)).toEqual([]);
  });

  it("matches trusted domains on subdomains but not lookalikes", () => {
    const evidence = toEvidence(
      [
        { title: "a", url: "https://www.factcheck.org/a", content: "a", score: 0.9 },
        { title: "b", url: "https://notfactcheck.org/b", content: "b", score: 0.9 },
      ],
      options,
    );
    expect(evidence.map((e) => e.trusted)).toEqual([true, false]);
  });
});
