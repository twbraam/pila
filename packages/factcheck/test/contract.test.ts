import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseContractTranscript, segmentsToTranscript, toPipelineSentences } from "../src/contract.js";
import { InvalidInputError } from "../src/errors.js";
import type { TranscriptSegment } from "../src/types.js";

const segments: TranscriptSegment[] = JSON.parse(
  readFileSync(new URL("../../../ref/transcript.json", import.meta.url), "utf8"),
);

const transcript = {
  videoId: "OwqIy8Ikv-c",
  sentences: [
    { id: "s1", text: "I’m an atmospheric physicist.", startSeconds: 2.52, endSeconds: 4.22 },
    { id: "s2", text: "我在 MIT 任教了 30 年\nFor 30 years I taught at MIT.", startSeconds: 7.88, endSeconds: 14.08 },
  ],
};

describe("parseContractTranscript", () => {
  it("accepts a README Transcript", () => {
    expect(parseContractTranscript(transcript)).toEqual(transcript);
  });

  it.each([
    ["missing videoId", { sentences: transcript.sentences }],
    ["no sentences", { videoId: "v", sentences: [] }],
    ["empty sentence id", { videoId: "v", sentences: [{ ...transcript.sentences[0], id: "" }] }],
    ["end before start", { videoId: "v", sentences: [{ ...transcript.sentences[0], endSeconds: 1 }] }],
    ["duplicate ids", { videoId: "v", sentences: [transcript.sentences[0], transcript.sentences[0]] }],
    [
      "too many sentences",
      { videoId: "v", sentences: Array.from({ length: 10_001 }, (_, i) => ({ id: `s${i}`, text: "x", startSeconds: i, endSeconds: i })) },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => parseContractTranscript(input)).toThrow(InvalidInputError);
  });
});

describe("toPipelineSentences", () => {
  it("keeps the line in the chosen language and remembers the original sentence", () => {
    const pairs = toPipelineSentences(transcript, "en");
    expect(pairs.map((p) => p.sentence)).toEqual([
      { index: 0, start: 2.52, text: "I’m an atmospheric physicist." },
      { index: 1, start: 7.88, text: "For 30 years I taught at MIT." },
    ]);
    expect(pairs[1]?.ref.id).toBe("s2");
  });

  it("caps very long sentences like the caption path does", () => {
    const long = { videoId: "v", sentences: [{ id: "a", text: "word ".repeat(5000), startSeconds: 0, endSeconds: 1 }] };
    expect(toPipelineSentences(long, "en")[0]?.sentence.text.length).toBeLessThanOrEqual(400);
  });

  it("drops sentences with no text in the chosen language", () => {
    const pairs = toPipelineSentences(transcript, "zh");
    expect(pairs.map((p) => [p.ref.id, p.sentence.text])).toEqual([["s2", "我在 MIT 任教了 30 年"]]);
  });
});

describe("segmentsToTranscript", () => {
  it("rejects invalid caption segments with InvalidInputError", () => {
    expect(() => segmentsToTranscript("v", { not: "segments" } as never)).toThrow(InvalidInputError);
  });

  it("builds a README Transcript from raw caption segments", () => {
    const result = segmentsToTranscript("OwqIy8Ikv-c", segments);
    expect(result.videoId).toBe("OwqIy8Ikv-c");
    expect(result.sentences).toHaveLength(40);
    expect(result.sentences[2]).toEqual({
      id: "OwqIy8Ikv-c-2",
      text: "For 30 years I taught at MIT, during which time the climate has changed remarkably little.",
      startSeconds: 7.88,
      endSeconds: 14.08,
    });
  });
});
