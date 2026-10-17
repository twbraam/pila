import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TRUSTED_DOMAINS } from "../src/config.js";
import { AuthError, CancelledError, RateLimitError, UpstreamError } from "../src/errors.js";
import { createJevClient } from "../src/jev/client.js";
import { buildDetectionRequest, findClaims } from "../src/jev/detect.js";
import { buildVerificationRequest, splitEvidenceSentences, verifyWithJev } from "../src/jev/verify.js";
import { toEvidence } from "../src/tavily.js";
import { toSentences } from "../src/transcript.js";
import type { Evidence, Sentence } from "../src/types.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";
import { choiceAnswer, JEV, jevResponder, noulAnswer } from "./helpers/fake-jev.js";

const sentences: Sentence[] = [
  { index: 0, start: 2.5, text: "I’m an atmospheric physicist." },
  { index: 1, start: 7.9, text: "During my 30 years at MIT the climate changed remarkably little." },
  { index: 2, start: 14.8, text: "But the cry of global warming has grown ever more shrill." },
  { index: 3, start: 107.8, text: "There is no evidence that CO2 emissions are the dominant factor." },
];

const evidence: Evidence[] = [
  {
    source: "Science Feedback",
    title: "Review - Science Feedback",
    url: "https://science.feedback.org/review/x",
    text: "In the video, Lindzen claims there is no evidence. This is false, attribution studies show otherwise.",
    trusted: true,
    score: 0.85,
  },
  { source: "facebook.com", title: "", url: "https://www.facebook.com/x", text: "Unrelated post", trusted: false, score: 0.7 },
];

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const lindzenSentences = toSentences(read("../../../ref/transcript.json"), "en");

const VERDICTS = ["false", "misleading", "true", "insufficient_evidence"];
const STANCES = ["refutes", "supports", "not_relevant"];

const jevClient = (fetch: ReturnType<typeof fakeFetch>["fetch"]) =>
  createJevClient({ apiKey: "ts-test", model: "jev-1.13.0", fetch, maxRetries: 0 });

describe("buildDetectionRequest", () => {
  it("asks one checkable noul per sentence, pointing at it by index", () => {
    const { state, questions } = buildDetectionRequest(sentences);
    expect(state).toEqual({ sentences: sentences.map((s) => s.text) });
    expect(Object.keys(questions)).toEqual(["checkable_0", "checkable_1", "checkable_2", "checkable_3"]);
    expect(questions.checkable_3).toMatchObject({
      type: "noul",
      instructions: "Is `sentences[3]` a specific factual claim that could be checked against outside sources?",
    });
  });
});

describe("documented examples", () => {
  it("claim-detection.request.json is what the library builds for ref/transcript.json", () => {
    const { model, ...body } = read("../../../docs/research/examples/claim-detection.request.json");
    expect(model).toBe("jev-1.13.0");
    expect(body).toEqual(buildDetectionRequest(lindzenSentences));
  });

  it("youtube-claim-verification.request.json is what the library builds for the CO2 claim", () => {
    const { model, ...body } = read("../../../docs/research/examples/youtube-claim-verification.request.json");
    const evidence = toEvidence(read("./fixtures/tavily-lindzen.json").results, {
      trustedDomains: DEFAULT_TRUSTED_DOMAINS,
      minScore: 0.4,
      maxSources: 3,
      maxChars: 1500,
    });
    const claim = lindzenSentences.find((s) => s.text.includes("no evidence that CO2"))!.text;
    expect(model).toBe("jev-1.13.0");
    expect(body).toEqual(buildVerificationRequest(claim, evidence));
  });
});

describe("findClaims", () => {
  const scores = [0.2, 0.9, 0.4, 0.95];
  const responder = jevResponder((key) => noulAnswer(scores[Number(key.split("_")[1])]!));

  it("keeps sentences above the threshold, best first up to the limit, then in video order", async () => {
    const { fetch } = fakeFetch({ [JEV]: responder });
    const result = await findClaims(jevClient(fetch), sentences, { threshold: 0.7, maxClaims: 5, maxPerRequest: 150, concurrency: 2 });
    expect(result.claims.map((c) => [c.index, c.checkable])).toEqual([
      [1, 0.9],
      [3, 0.95],
    ]);
    expect(result.inputTokens).toBe(100);
    expect(result.model).toBe("jev-1.13.0");
  });

  it("takes only the top claims when there are more than the limit", async () => {
    const { fetch } = fakeFetch({ [JEV]: responder });
    const result = await findClaims(jevClient(fetch), sentences, { threshold: 0.1, maxClaims: 2, maxPerRequest: 150, concurrency: 2 });
    expect(result.claims.map((c) => c.index)).toEqual([1, 3]);
  });

  it("splits long transcripts into several requests and maps answers back", async () => {
    const { fetch, calls } = fakeFetch({
      [JEV]: jevResponder((key, _q, body) => {
        const local = Number(key.split("_")[1]);
        const text = (body.state as { sentences: string[] }).sentences[local]!;
        return noulAnswer(text.includes("CO2") ? 0.95 : 0.1);
      }),
    });
    const result = await findClaims(jevClient(fetch), sentences, { threshold: 0.7, maxClaims: 5, maxPerRequest: 3, concurrency: 2 });
    expect(calls).toHaveLength(2);
    expect(result.claims.map((c) => c.index)).toEqual([3]);
    expect(result.inputTokens).toBe(200);
  });

  it("rejects an answer with the wrong shape", async () => {
    const { fetch } = fakeFetch({ [JEV]: jevResponder(() => choiceAnswer("x", 1, ["x", "y"])) });
    const run = findClaims(jevClient(fetch), sentences, { threshold: 0.7, maxClaims: 5, maxPerRequest: 150, concurrency: 1 });
    await expect(run).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("buildVerificationRequest", () => {
  it("matches the team's payload shape: claim, labeled evidence, verdicts, one stance per source", () => {
    const { state, questions } = buildVerificationRequest("CO2 is not the dominant factor.", evidence);
    expect(state).toEqual({
      claim: "CO2 is not the dominant factor.",
      evidence: {
        source_1: { source: "Science Feedback", text: "In the video, Lindzen claims there is no evidence. This is false, attribution studies show otherwise." },
        source_2: { source: "facebook.com", text: "Unrelated post" },
      },
    });
    expect(Object.keys(questions)).toEqual([
      "verdict",
      "verdict_reversed",
      "source_1_stance",
      "source_2_stance",
      "source_1_quote",
      "source_2_quote",
    ]);
    expect(questions.source_1_quote).toMatchObject({
      type: "choice",
      instructions: "Which sentence of `evidence.source_1` best states what it concludes about `claim`?",
      criteria: {
        s0: "In the video, Lindzen claims there is no evidence.",
        s1: "This is false, attribution studies show otherwise.",
        none: "No sentence says whether the claim is true or false",
      },
    });
    expect(Object.keys(questions.verdict!.criteria!)).toEqual(VERDICTS);
    expect(Object.keys(questions.verdict_reversed!.criteria!)).toEqual([...VERDICTS].reverse());
    expect(questions.source_2_stance!.instructions).toBe("What does `evidence.source_2` say about `claim`?");
  });
});

describe("verifyWithJev", () => {
  it("returns both verdicts and a stance per source", async () => {
    const { fetch } = fakeFetch({
      [JEV]: jevResponder((key) => {
        if (key.startsWith("verdict")) return choiceAnswer("false", 0.9, VERDICTS);
        if (key === "source_1_quote") return choiceAnswer("s1", 0.8, ["s0", "s1", "none"]);
        if (key === "source_2_quote") return choiceAnswer("none", 0.9, ["s0", "none"]);
        return key === "source_1_stance" ? choiceAnswer("refutes", 0.93, STANCES) : choiceAnswer("not_relevant", 0.8, STANCES);
      }),
    });
    const result = await verifyWithJev(jevClient(fetch), "CO2 is not the dominant factor.", evidence);
    expect(result.verdict).toEqual({ choice: "false", confidence: 0.9 });
    expect(result.verdictReversed).toEqual({ choice: "false", confidence: 0.9 });
    expect(result.sources.map((s) => [s.source, s.stance, s.stanceConfidence])).toEqual([
      ["Science Feedback", "refutes", 0.93],
      ["facebook.com", "not_relevant", 0.8],
    ]);
    expect(result.sources.map((s) => s.quote)).toEqual(["This is false, attribution studies show otherwise.", undefined]);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(100);
  });

  it("drops a quote with an unexpected answer instead of failing the claim", async () => {
    const { fetch } = fakeFetch({
      [JEV]: jevResponder((key) => {
        if (key.startsWith("verdict")) return choiceAnswer("false", 0.9, VERDICTS);
        if (key.endsWith("_quote")) return choiceAnswer("s99", 0.9, ["s99", "none"]);
        return choiceAnswer("refutes", 0.9, STANCES);
      }),
    });
    const result = await verifyWithJev(jevClient(fetch), "claim", evidence);
    expect(result.sources.map((s) => s.quote)).toEqual([undefined, undefined]);
  });

  it("rejects a verdict outside the allowed options", async () => {
    const { fetch } = fakeFetch({ [JEV]: jevResponder(() => choiceAnswer("maybe", 0.9, ["maybe", "no"])) });
    await expect(verifyWithJev(jevClient(fetch), "claim", evidence)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("splitEvidenceSentences", () => {
  it("splits on sentence ends and Tavily chunk breaks, dropping fragments", () => {
    expect(splitEvidenceSentences("First point here. Second point here! [...] Third one is here? ok. 這是中文句子。")).toEqual([
      "First point here.",
      "Second point here!",
      "Third one is here?",
      "這是中文句子。",
    ]);
  });

  it("caps the number and length of sentences", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} ${"x".repeat(400)}.`).join(" ");
    const sentences = splitEvidenceSentences(text);
    expect(sentences).toHaveLength(20);
    for (const s of sentences) expect(s.length).toBeLessThanOrEqual(300);
  });
});

describe("createJevClient errors", () => {
  const ask = (status: number) => {
    const { fetch } = fakeFetch({ [JEV]: () => json({ detail: { error_type: "x" } }, status) });
    return verifyWithJev(jevClient(fetch), "claim", evidence);
  };

  it.each([
    [401, AuthError],
    [403, AuthError],
    [429, RateLimitError],
    [529, UpstreamError],
    [422, UpstreamError],
  ])("maps HTTP %i to %o", async (status, ErrorClass) => {
    await expect(ask(status)).rejects.toBeInstanceOf(ErrorClass);
    await expect(ask(status)).rejects.toMatchObject({ service: "jev", status });
  });

  it("maps network failures to UpstreamError", async () => {
    const { fetch } = fakeFetch({});
    await expect(verifyWithJev(jevClient(fetch), "claim", evidence)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("maps an aborted signal to CancelledError", async () => {
    const { fetch } = fakeFetch({ [JEV]: jevResponder(() => noulAnswer(1)) });
    const controller = new AbortController();
    controller.abort();
    await expect(verifyWithJev(jevClient(fetch), "claim", evidence, controller.signal)).rejects.toBeInstanceOf(CancelledError);
  });

  it("rejects an empty API key", () => {
    expect(() => createJevClient({ apiKey: "", model: "jev-1.13.0" })).toThrow(AuthError);
  });
});
