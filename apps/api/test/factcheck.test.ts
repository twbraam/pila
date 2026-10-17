import { describe, expect, it } from "vitest";
import { factCheckProviders, isFactCheckSource, mockFactCheck, parseFactCheckItems } from "../src/factcheck/index.js";
import { getMockTranscript } from "../src/transcripts/index.js";

const item = { timestamp: 42.5, sentence: "Sample excerpt", score: 2, sources: ["https://factcheck.org/x"] };

describe("mockFactCheck", () => {
  it("returns fixed items in the required shape, in video order", async () => {
    const items = await mockFactCheck(await getMockTranscript("OwqIy8Ikv-c"));
    expect(items.length).toBeGreaterThan(0);
    expect(parseFactCheckItems(items)).toEqual(items);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(["score", "sentence", "sources", "timestamp"]);
    expect(items.map((i) => i.timestamp)).toEqual([...items.map((i) => i.timestamp)].sort((a, b) => a - b));
  });

  it("uses sentences that are in the mock transcript", async () => {
    const transcript = await getMockTranscript("OwqIy8Ikv-c");
    const text = transcript.segments.map((s) => s.text.split("\n").at(-1)).join(" "); // the English line
    for (const i of await mockFactCheck(transcript)) expect(text).toContain(i.sentence);
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mockFactCheck(await getMockTranscript("OwqIy8Ikv-c"), { signal: controller.signal })).rejects.toThrow();
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
