import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factCheckProviders, isFactCheckSource, mockFactCheck, parseFactCheckItems } from "../src/factcheck/index.js";
import { toFactCheckItem } from "../src/factcheck/mock.js";
import { getMockTranscript } from "../src/transcripts/index.js";

const item = { timestamp: 42.5, sentence: "Sample excerpt", score: 2, sources: ["https://factcheck.org/x"] };

const RUNS = {
  "OwqIy8Ikv-c": "../../../results/OwqIy8Ikv-c/20261017T070618135Z/results.json",
  "7wFWgopJP5Q": "../../../results/7wFWgopJP5Q/20261017T071219936Z/results.json",
} as const;
const IDS = Object.keys(RUNS) as (keyof typeof RUNS)[];
type Target = { text: string; start: number; suspectedIssue: boolean };
const run = (id: keyof typeof RUNS): { targets: Target[] } => JSON.parse(readFileSync(new URL(RUNS[id], import.meta.url), "utf8"));
const check = async (videoId: string) => mockFactCheck(await getMockTranscript(videoId));

describe("mockFactCheck", () => {
  it.each(IDS)("bundles an exact copy of the recorded Jev run for %s", (id) => {
    const copy = JSON.parse(readFileSync(new URL(`../src/factcheck/mock-results/${id}.json`, import.meta.url), "utf8"));
    expect(copy).toEqual(run(id));
  });

  it.each(IDS)("returns one item per Jev target of %s, in video order", async (id) => {
    const items = await check(id);
    const targets = run(id).targets;
    expect(parseFactCheckItems(items)).toEqual(items);
    expect(items.map((i) => i.timestamp)).toEqual(targets.map((t) => t.start));
    expect(items.map((i) => i.sentence)).toEqual(targets.map((t) => t.text.replaceAll("&quot;", '"').trim()));
    for (const i of items) expect(Object.keys(i).sort()).toEqual(["score", "sentence", "sources", "timestamp"]);
  });

  it.each(IDS)("gives score >= 2 exactly to what Jev flagged in %s", async (id) => {
    const flagged = run(id).targets.filter((t) => t.suspectedIssue).map((t) => t.start);
    expect((await check(id)).filter((i) => i.score >= 2).map((i) => i.timestamp)).toEqual(flagged);
  });

  it("floors Jev's 0-3 suspicion score", async () => {
    const items = await check("OwqIy8Ikv-c");
    expect(items[0]).toEqual({ timestamp: 2.42, sentence: "I’m an atmospheric physicist.", score: 0, sources: [] });
    expect(items.find((i) => i.sentence.startsWith("For 30 years"))?.score).toBe(2); // 2.69
    expect(items.find((i) => i.sentence.startsWith("4) Over this period"))?.score).toBe(1); // 1.95, below threshold
  });

  it("returns the Chinese run for 7wFWgopJP5Q, with HTML entities decoded", async () => {
    const items = await check("7wFWgopJP5Q");
    expect(items[0]).toEqual({ timestamp: 22.872, sentence: "有沒有人知道我在講哪一國的語言?", score: 0, sources: [] });
    expect(items.some((i) => i.sentence.includes("&quot;"))).toBe(false);
  });

  it("falls back to the English run for any other video", async () => {
    expect(await check("dQw4w9WgXcQ")).toEqual(await check("OwqIy8Ikv-c"));
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mockFactCheck(await getMockTranscript("OwqIy8Ikv-c"), { signal: controller.signal })).rejects.toThrow();
  });
});

describe("toFactCheckItem", () => {
  it("clamps scores to 0-3 and decodes HTML entities", () => {
    const target = { sentenceId: "s1", text: " &quot;x&quot; &amp; y ", start: 1, suspicionScore: 0 };
    expect(toFactCheckItem({ ...target, suspicionScore: 3.4 })).toEqual({ timestamp: 1, sentence: '"x" & y', score: 3, sources: [] });
    expect(toFactCheckItem({ ...target, suspicionScore: -0.2 }).score).toBe(0);
  });
});

describe("parseFactCheckItems", () => {
  it("accepts valid items and an empty list", () => {
    expect(parseFactCheckItems([item])).toEqual([item]);
    expect(parseFactCheckItems([])).toEqual([]);
  });

  it("keeps only the contract fields", () => {
    expect(parseFactCheckItems([{ ...item, extra: "x" }])).toEqual([item]);
  });

  it.each([
    ["not an array", { items: [] }],
    ["a negative timestamp", [{ ...item, timestamp: -1 }]],
    ["a score above 3", [{ ...item, score: 4 }]],
    ["a fractional score", [{ ...item, score: 1.5 }]],
    ["a missing sentence", [{ ...item, sentence: undefined }]],
    ["sources that are not strings", [{ ...item, sources: [{ url: "https://x.org" }] }]],
    ["a non-http source", [{ ...item, sources: ["javascript:alert(1)"] }]],
  ])("rejects %s", (_name, value) => {
    expect(() => parseFactCheckItems(value)).toThrow();
  });
});

describe("factCheckProviders", () => {
  it("has the mock registered", () => {
    expect(factCheckProviders.mock).toBe(mockFactCheck);
    expect(isFactCheckSource("mock")).toBe(true);
    expect(isFactCheckSource("toString")).toBe(false);
  });
});

describe("mock evidence", () => {
  it("adds sources to the searched claims only", async () => {
    const items = await check("OwqIy8Ikv-c");
    const withSources = items.filter((i) => i.sources.length > 0).map((i) => i.timestamp);
    expect(withSources).toEqual([2.42, 101.68, 168.7]); // s0003, s0017, s0024; s0025 was not searched (budget)
    expect(items.find((i) => i.timestamp === 168.7)?.sources[0]).toBe("https://www.ipcc.ch/sr15");
  });

  it("adds sources to both flagged Chinese claims", async () => {
    const items = await check("7wFWgopJP5Q");
    expect(items.filter((i) => i.sources.length > 0).map((i) => i.timestamp)).toEqual([543.819, 646.029]);
  });
});
