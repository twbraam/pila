import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/concurrency.js";
import { claimQuery, videoQuery } from "../src/queries.js";

describe("videoQuery", () => {
  it("combines title and channel with 'fact check'", () => {
    expect(videoQuery({ title: "What Do Climate Scientists Say?", channel: "PragerU" }, "en")).toBe(
      "What Do Climate Scientists Say? PragerU fact check",
    );
  });

  it("uses the Chinese phrase in Chinese mode", () => {
    expect(videoQuery({ channel: "PragerU" }, "zh")).toBe("PragerU 事實查核");
  });

  it("returns undefined without a title or channel", () => {
    expect(videoQuery({ id: "abc" }, "en")).toBeUndefined();
    expect(videoQuery({ title: "  " }, "en")).toBeUndefined();
  });
});

describe("claimQuery", () => {
  it("adds 'fact check' to the claim", () => {
    expect(claimQuery("CO2 is not the main driver.", "en")).toBe("CO2 is not the main driver. fact check");
    expect(claimQuery("二氧化碳不是主因", "zh")).toBe("二氧化碳不是主因 事實查核");
  });

  it("prefixes the channel when known, which finds reviews of the video", () => {
    expect(claimQuery("CO2 is not the main driver.", "en", { channel: "PragerU" })).toBe(
      "PragerU: CO2 is not the main driver. fact check",
    );
    expect(claimQuery("CO2 is not the main driver.", "en", { title: "x" })).toBe("CO2 is not the main driver. fact check");
  });
});

describe("mapLimit", () => {
  it("keeps input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimit([30, 10, 20, 5], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i;
    });
    expect(result).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("rejects when a task fails", async () => {
    await expect(mapLimit([1, 2], 2, async (n) => (n === 2 ? Promise.reject(new Error("boom")) : n))).rejects.toThrow("boom");
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
  });
});
