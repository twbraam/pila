import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getMockTranscript } from "../src/transcripts/mock.js";
import { isYouTubeVideoId, transcriptProviders } from "../src/transcripts/index.js";

const ref = JSON.parse(readFileSync(new URL("../../../ref/transcript.json", import.meta.url), "utf8"));

describe("getMockTranscript", () => {
  it("returns the team's mock transcript (ref/transcript.json) for any video", async () => {
    expect(await getMockTranscript("OwqIy8Ikv-c")).toEqual({ videoId: "OwqIy8Ikv-c", segments: ref });
    expect((await getMockTranscript("dQw4w9WgXcQ")).segments).toEqual(ref);
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getMockTranscript("OwqIy8Ikv-c", { signal: controller.signal })).rejects.toThrow();
  });
});

describe("transcriptProviders", () => {
  it("has the mock registered", () => {
    expect(transcriptProviders.mock).toBe(getMockTranscript);
  });
});

describe("isYouTubeVideoId", () => {
  it.each(["OwqIy8Ikv-c", "dQw4w9WgXcQ", "a_b-c_d-e_f"])("accepts %s", (id) => expect(isYouTubeVideoId(id)).toBe(true));
  it.each(["", "short", "OwqIy8Ikv-c1", "OwqIy8Ikv/c", "https://youtu.be/OwqIy8Ikv-c", 12345678901])("rejects %s", (id) =>
    expect(isYouTubeVideoId(id)).toBe(false),
  );
});
