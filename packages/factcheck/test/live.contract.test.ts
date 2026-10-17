/**
 * Calls the real APIs. Run by hand: `npm run test:contract -w @pila/factcheck`.
 * Keys come from the environment or the repo's .env; each suite skips without its key.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFactChecker } from "../src/index.js";
import { createTavilyClient } from "../src/tavily.js";
import type { TranscriptSegment } from "../src/types.js";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { TYPESAFE_API_KEY, TAVILY_API_KEY } = process.env;

const transcript: TranscriptSegment[] = JSON.parse(
  readFileSync(new URL("../../../ref/transcript.json", import.meta.url), "utf8"),
);

describe.skipIf(!TAVILY_API_KEY)("Tavily (live)", () => {
  it("returns results in the shape we parse, with the video review near the top", async () => {
    const tavily = createTavilyClient({ apiKey: TAVILY_API_KEY });
    const response = await tavily.search({
      query: "Richard Lindzen PragerU climate change video claims fact check",
      searchDepth: "advanced",
      includeDomains: ["science.feedback.org", "climatefeedback.org"],
    });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.credits).toBeGreaterThan(0);
    const top3 = response.results.slice(0, 3).map((r) => r.url);
    expect(top3.some((u) => u.includes("feedback.org"))).toBe(true);
  });
});

describe.skipIf(!TYPESAFE_API_KEY)("Jev + Tavily end to end (live)", () => {
  it("labels claims from the Lindzen video as false or misleading", async () => {
    const checker = createFactChecker({ typesafeApiKey: TYPESAFE_API_KEY!, tavilyApiKey: TAVILY_API_KEY });
    const report = await checker.checkVideo({ video: { channel: "PragerU", title: "Climate Change: What Do Scientists Say?" }, transcript });
    expect(report.model).toMatch(/^jev-/);
    expect(report.claims.length).toBeGreaterThan(0);
    // The video's main false claim (reviewed by Science Feedback) must be picked and flagged.
    // Other picks can be true: the video also lists real "points of agreement".
    const co2 = report.claims.find((c) => c.claim.text.includes("no evidence that CO2 emissions are the dominant factor"));
    expect(co2?.label).toMatch(/^(false|misleading)$/);
  });
});
