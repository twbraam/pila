import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/errors.js";
import { detectLanguage, parseTranscript, toSentences } from "../src/transcript.js";
import type { TranscriptSegment } from "../src/types.js";

const lindzen: TranscriptSegment[] = JSON.parse(
  readFileSync(new URL("../../../ref/transcript.json", import.meta.url), "utf8"),
);

const seg = (text: string, start: number, duration = 1): TranscriptSegment => ({ text, start, duration });

describe("toSentences (English)", () => {
  it("merges the bilingual Lindzen transcript into 40 English sentences", () => {
    const sentences = toSentences(lindzen, "en");
    expect(sentences).toHaveLength(40);
    expect(sentences[0]).toEqual({ index: 0, start: 2.52, text: "I’m an atmospheric physicist." });
    expect(sentences[2]).toEqual({
      index: 2,
      start: 7.88,
      text: "For 30 years I taught at MIT, during which time the climate has changed remarkably little.",
    });
  });

  it("numbers sentences in order", () => {
    const sentences = toSentences(lindzen, "en");
    expect(sentences.map((s) => s.index)).toEqual(sentences.map((_, i) => i));
  });

  it("keeps a trailing sentence without end punctuation", () => {
    const sentences = toSentences([seg("Hello there.", 0), seg("and then", 1)], "en");
    expect(sentences.map((s) => s.text)).toEqual(["Hello there.", "and then"]);
  });

  it("removes caption cues and decodes HTML entities", () => {
    const sentences = toSentences([seg("[Music] It&#39;s &quot;fine&quot; &amp; good.", 0)], "en");
    expect(sentences[0]?.text).toBe('It\'s "fine" & good.');
  });

  it("leaves out-of-range numeric entities alone instead of throwing", () => {
    expect(toSentences([seg("Bad &#99999999; entity.", 0)], "en")[0]?.text).toBe("Bad &#99999999; entity.");
  });

  it("splits text without punctuation once it gets too long", () => {
    const words = Array.from({ length: 30 }, (_, i) => seg(`word${i} and some more words here`, i));
    const sentences = toSentences(words, "en");
    expect(sentences.length).toBeGreaterThan(1);
    for (const s of sentences) expect(s.text.length).toBeLessThanOrEqual(400);
  });
});

describe("toSentences (Chinese)", () => {
  it("uses the Chinese line and English sentence boundaries in a bilingual transcript", () => {
    const sentences = toSentences(lindzen, "zh");
    expect(sentences).toHaveLength(40);
    expect(sentences[2]?.text).toBe("我在 MIT 任教了 30 年 这期间气候变化极小");
  });

  it("splits a Chinese-only transcript on Chinese punctuation", () => {
    const sentences = toSentences([seg("今天天氣很好。", 0), seg("我們去公園", 1), seg("散步！", 2)], "zh");
    expect(sentences.map((s) => s.text)).toEqual(["今天天氣很好。", "我們去公園 散步！"]);
    expect(sentences[1]?.start).toBe(1);
  });
});

describe("detectLanguage", () => {
  it("prefers English when the transcript has English lines", () => {
    expect(detectLanguage(lindzen)).toBe("en");
  });

  it("returns zh when only a few stray lines are Latin", () => {
    const chinese = [seg("今天天氣很好。", 0), seg("OK", 1), seg("我們去公園散步。", 2), seg("2024", 3), seg("晚上回家。", 4)];
    expect(detectLanguage(chinese)).toBe("zh");
  });

  it("returns zh for a Chinese-only transcript", () => {
    expect(detectLanguage([seg("今天天氣很好。", 0)])).toBe("zh");
  });
});

describe("parseTranscript", () => {
  it("accepts valid segments", () => {
    expect(parseTranscript(lindzen)).toHaveLength(lindzen.length);
  });

  it.each([
    ["not an array", { text: "x" }],
    ["empty", []],
    ["missing start", [{ text: "x", duration: 1 }]],
    ["negative start", [{ text: "x", start: -1, duration: 1 }]],
  ])("rejects %s", (_name, input) => {
    expect(() => parseTranscript(input)).toThrow(InvalidInputError);
  });
});
