import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factCheckProviders, isFactCheckSource, mockFactCheck, parseFactCheckItems } from "../src/factcheck/index.js";
import { toFactCheckItem } from "../src/factcheck/mock.js";
import { getMockTranscript } from "../src/transcripts/index.js";

const item = { timestamp: 42.5, sentence: "Sample excerpt", score: 2, sources: ["https://factcheck.org/x"] };

const JEV_RUN = "../../../results/OwqIy8Ikv-c/20261017T070618135Z/results.json";
const jevRun = JSON.parse(readFileSync(new URL(JEV_RUN, import.meta.url), "utf8"));

describe("mockFactCheck", () => {
  it("bundles an exact copy of the recorded Jev run", () => {
    expect(JSON.parse(readFileSync(new URL("../src/factcheck/mock-jev-results.json", import.meta.url), "utf8"))).toEqual(jevRun);
  });

  it("returns one item per screened sentence, from the Jev run, in video order", async () => {
    const items = await mockFactCheck(await getMockTranscript("OwqIy8Ikv-c"));
    expect(parseFactCheckItems(items)).toEqual(items);
    expect(items).toHaveLength(jevRun.targets.length);
    expect(items.map((i) => i.sentence)).toEqual(jevRun.targets.map((t: { text: string }) => t.text));
    expect(items.map((i) => i.timestamp)).toEqual(jevRun.targets.map((t: { start: number }) => t.start));
    for (const i of items) expect(Object.keys(i).sort()).toEqual(["score", "sentence", "sources", "timestamp"]);
  });

  it("floors Jev's 0-3 suspicion score, so score >= 2 means Jev flagged the sentence", async () => {
    const items = await mockFactCheck(await getMockTranscript("OwqIy8Ikv-c"));
    expect(items[0]).toEqual({ timestamp: 2.42, sentence: "I’m an atmospheric physicist.", score: 0, sources: [] });
    expect(items.find((i) => i.sentence.startsWith("For 30 years"))?.score).toBe(2); // suspicionScore 2.69
    expect(items.find((i) => i.sentence.startsWith("4) Over this period"))?.score).toBe(1); // 1.95, below threshold
    const flagged = jevRun.targets.filter((t: { suspectedIssue: boolean }) => t.suspectedIssue).map((t: { text: string }) => t.text);
    expect(items.filter((i) => i.score >= 2).map((i) => i.sentence)).toEqual(flagged);
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mockFactCheck(await getMockTranscript("OwqIy8Ikv-c"), { signal: controller.signal })).rejects.toThrow();
  });
});

describe("toFactCheckItem", () => {
  it("clamps scores to 0-3", () => {
    const target = { text: "x", start: 1, suspicionScore: 0 };
    expect(toFactCheckItem({ ...target, suspicionScore: 3.4 }).score).toBe(3);
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
