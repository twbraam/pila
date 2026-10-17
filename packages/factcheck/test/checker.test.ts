import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthError, CancelledError, InvalidInputError } from "../src/errors.js";
import { createFactChecker } from "../src/index.js";
import type { ProgressEvent, TranscriptSegment } from "../src/types.js";
import { fakeFetch, json, type Handler } from "./helpers/fake-fetch.js";
import { choiceAnswer, JEV, type JevRequestBody, jevResponder, noulAnswer } from "./helpers/fake-jev.js";

const transcript: TranscriptSegment[] = JSON.parse(
  readFileSync(new URL("../../../ref/transcript.json", import.meta.url), "utf8"),
);
const tavilyFixture = JSON.parse(readFileSync(new URL("./fixtures/tavily-lindzen.json", import.meta.url), "utf8"));
const TAVILY = "https://api.tavily.com/search";
const VERDICTS = ["false", "misleading", "true", "insufficient_evidence"];
const STANCES = ["refutes", "supports", "not_relevant"];
const video = { id: "lindzen", title: "What Do Climate Scientists Say?", channel: "PragerU" };

const isCheckable = (text: string) => /CO2|IPCC|1\.8 degrees/.test(text);

/** Detection: sentences mentioning CO2, IPCC, or 1.8 degrees are claims. Verification: false, Science Feedback refutes. */
const jev = jevResponder((key, _q, body: JevRequestBody) => {
  if (key.startsWith("checkable_")) {
    const sentences = (body.state as { sentences: string[] }).sentences;
    return noulAnswer(isCheckable(sentences[Number(key.split("_")[1])]!) ? 0.9 : 0.1);
  }
  if (key.startsWith("verdict")) return choiceAnswer("false", 0.9, VERDICTS);
  const evidence = (body.state as { evidence: Record<string, { source: string }> }).evidence;
  const source = evidence[key.replace("_stance", "")]!.source;
  return source === "Science Feedback" ? choiceAnswer("refutes", 0.93, STANCES) : choiceAnswer("not_relevant", 0.8, STANCES);
}, 500);

const setup = (routes: Record<string, Handler> = {}) => {
  const fake = fakeFetch({ [JEV]: jev, [TAVILY]: () => json(tavilyFixture), ...routes });
  const checker = createFactChecker({ typesafeApiKey: "ts-test", tavilyApiKey: "tvly-test", fetch: fake.fetch, maxRetries: 0 });
  return { ...fake, checker };
};

const tavilyQueries = (calls: ReturnType<typeof fakeFetch>["calls"]) =>
  calls.filter((c) => c.url === TAVILY).map((c) => (c.body as { query: string }).query);

describe("checkVideo", () => {
  it("finds claims, searches evidence, and labels each claim", async () => {
    const { checker, calls } = setup();
    const events: ProgressEvent[] = [];
    const report = await checker.checkVideo({ video, transcript }, { onProgress: (e) => events.push(e) });

    expect(report.language).toBe("en");
    expect(report.model).toBe("jev-1.13.0");
    expect(report.claims.length).toBeGreaterThan(0);
    expect(report.claims.length).toBeLessThanOrEqual(5);
    for (const result of report.claims) {
      expect(result.label).toBe("false");
      expect(result.confidence).toBe(0.93);
      expect(result.sources[0]).toMatchObject({ source: "Science Feedback", stance: "refutes", trusted: true });
      expect(result.sources.length).toBeLessThanOrEqual(5);
    }
    expect(report.claims.map((c) => c.claim.start)).toEqual([...report.claims.map((c) => c.claim.start)].sort((a, b) => a - b));
    expect(report.videoReviews).toHaveLength(4);
    const bodies = calls.filter((c) => c.url === TAVILY).map((c) => c.body as { search_depth: string; exclude_domains: string[] });
    expect(bodies.every((b) => b.search_depth === "advanced" && b.exclude_domains.includes("youtube.com"))).toBe(true);

    const queries = tavilyQueries(calls);
    expect(queries[0]).toBe("What Do Climate Scientists Say? PragerU fact check");
    expect(queries.slice(1).every((q) => q.startsWith("PragerU: "))).toBe(true);
    expect(queries).toHaveLength(report.claims.length + 1);
    expect(report.usage.tavilyCredits).toBe(2 + 2 * report.claims.length);
    expect(report.usage.jevInputTokens).toBe(500 * (report.claims.length + 1));
    expect(events.at(-1)).toEqual({ stage: "done", done: 1, total: 1 });
    expect(events.map((e) => e.stage)).toEqual(expect.arrayContaining(["sentences", "claims", "evidence", "verify"]));
  });

  it("keeps room for each claim's own evidence when the video search fills up", async () => {
    const review = (i: number) => ({ title: `Review ${i}`, url: `https://www.factcheck.org/review-${i}`, content: `Review ${i}`, score: 0.9 });
    const own = { title: "Own", url: "https://www.politifact.com/own", content: "About this claim", score: 0.9 };
    const { checker } = setup({
      [TAVILY]: (call) =>
        (call.body as { query: string }).query.startsWith("PragerU: ")
          ? json({ results: [own] })
          : json({ results: [1, 2, 3, 4, 5].map(review) }),
    });
    const report = await checker.checkVideo({ video, transcript });
    expect(report.videoReviews).toHaveLength(5);
    for (const c of report.claims) {
      expect(c.sources).toHaveLength(5);
      expect(c.sources.map((s) => s.url)).toContain("https://www.politifact.com/own");
    }
  });

  it("records a failed video-level search instead of hiding it", async () => {
    const { checker } = setup({
      [TAVILY]: (call) => ((call.body as { query: string }).query.startsWith("PragerU: ") ? json(tavilyFixture) : json({}, 500)),
    });
    const report = await checker.checkVideo({ video, transcript });
    expect(report.videoReviews).toEqual([]);
    expect(report.videoSearchError).toMatchObject({ name: "UpstreamError" });
    expect(report.claims.every((c) => c.label === "false")).toBe(true);
  });

  it("stops the run when Tavily credits are used up", async () => {
    const { checker } = setup({ [TAVILY]: () => json({}, 432) });
    await expect(checker.checkVideo({ video, transcript })).rejects.toMatchObject({ name: "QuotaError", service: "tavily" });
  });

  it("still counts Tavily credits when verification fails", async () => {
    const { checker } = setup({
      [JEV]: (call) =>
        Object.keys((call.body as JevRequestBody).questions)[0]!.startsWith("checkable_") ? jev(call) : json({}, 500),
    });
    const report = await checker.checkVideo({ transcript });
    expect(report.claims.every((c) => c.error?.name === "UpstreamError")).toBe(true);
    expect(report.usage.tavilyCredits).toBe(2 * report.claims.length);
  });

  it("skips the video-level search when there is no title or channel", async () => {
    const { checker, calls } = setup();
    const report = await checker.checkVideo({ transcript });
    expect(report.videoReviews).toEqual([]);
    expect(tavilyQueries(calls)).toHaveLength(report.claims.length);
  });

  it("uses Chinese sentences and queries in Chinese mode", async () => {
    const { checker, calls } = setup();
    const report = await checker.checkVideo({ video, transcript, language: "zh" });
    expect(report.language).toBe("zh");
    expect(tavilyQueries(calls).every((q) => q.endsWith("事實查核"))).toBe(true);
  });

  it("drops search results that reprint the transcript", async () => {
    const copy = { title: "Transcript", url: "https://copy.example.org/t", content: transcript.map((t) => t.text.split("\n")[1]).join(" "), score: 0.95 };
    const { checker } = setup({ [TAVILY]: () => json({ results: [copy] }) });
    const report = await checker.checkVideo({ video, transcript });
    expect(report.videoReviews).toEqual([]);
    expect(report.claims.every((c) => c.label === "insufficient_evidence")).toBe(true);
  });

  it("labels a claim insufficient_evidence without calling Jev when nothing is found", async () => {
    const { checker, calls } = setup({ [TAVILY]: () => json({ results: [] }) });
    const report = await checker.checkVideo({ transcript });
    expect(report.claims.length).toBeGreaterThan(0);
    expect(report.claims.every((c) => c.label === "insufficient_evidence" && c.sources.length === 0)).toBe(true);
    expect(calls.filter((c) => c.url === JEV)).toHaveLength(1); // detection only
  });

  it("keeps the other claims when one claim fails", async () => {
    let claimSearches = 0;
    const { checker } = setup({ [TAVILY]: () => (++claimSearches === 1 ? json({}, 500) : json(tavilyFixture)) });
    const report = await checker.checkVideo({ transcript });
    const failed = report.claims.filter((c) => c.error);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ label: "not_sure", error: { name: "UpstreamError" } });
    expect(report.claims.filter((c) => c.label === "false").length).toBe(report.claims.length - 1);
  });

  it("fails the whole run on a bad Tavily key", async () => {
    const { checker } = setup({ [TAVILY]: () => json({}, 401) });
    await expect(checker.checkVideo({ video, transcript })).rejects.toBeInstanceOf(AuthError);
  });

  it("fails the whole run on a bad Jev key", async () => {
    const { checker } = setup({ [JEV]: () => json({}, 401) });
    await expect(checker.checkVideo({ transcript })).rejects.toMatchObject({ name: "AuthError", service: "jev" });
  });

  it("rejects an invalid transcript", async () => {
    const { checker } = setup();
    await expect(checker.checkVideo({ transcript: [] })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(checker.checkVideo({ transcript: [{ text: "", start: 0, duration: 1 }] })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(checker.checkVideo({ transcript, language: "fr" } as never)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("stops with CancelledError when aborted", async () => {
    const { checker } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(checker.checkVideo({ transcript }, { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("createFactChecker", () => {
  it("requires a Jev API key", () => {
    expect(() => createFactChecker({ typesafeApiKey: "" })).toThrow(AuthError);
  });

  it("keeps defaults for limits passed as undefined", async () => {
    const { fetch } = fakeFetch({ [JEV]: jev, [TAVILY]: () => json(tavilyFixture) });
    const checker = createFactChecker({ typesafeApiKey: "k", fetch, maxRetries: 0, limits: { maxClaims: undefined } });
    const report = await checker.checkVideo({ transcript });
    expect(report.claims.length).toBeGreaterThan(0);
  });

  it("rejects invalid config", () => {
    expect(() => createFactChecker({ typesafeApiKey: "k", limits: { maxClaims: 0 } })).toThrow(InvalidInputError);
  });

  it("exposes the pipeline steps", async () => {
    const { checker } = setup();
    const claims = await checker.findClaims([
      { index: 0, start: 0, text: "Hello." },
      { index: 1, start: 1, text: "CO2 is not the dominant factor." },
    ]);
    expect(claims.map((c) => c.index)).toEqual([1]);

    const evidence = await checker.searchEvidence(claims[0]!.text);
    expect(evidence[0]?.source).toBe("Science Feedback");

    const result = await checker.verifyClaim(claims[0]!, evidence);
    expect(result).toMatchObject({ label: "false", jev: { model: "jev-1.13.0", verdict: "false", verdictReversed: "false" } });
  });
});
