/**
 * Bundled into test/sw/extension/sw.js and run inside a real MV3 service worker by sw.spec.ts.
 * Exposes test functions on the worker's global scope.
 */
import { createFactChecker, type FactCheckError, type TranscriptSegment } from "../../src/index.js";
import { fakeFetch, json } from "../helpers/fake-fetch.js";
import { choiceAnswer, JEV, jevResponder, noulAnswer } from "../helpers/fake-jev.js";

interface Args {
  readonly transcript: TranscriptSegment[];
  readonly tavilyFixture: unknown;
}

const VERDICTS = ["false", "misleading", "true", "insufficient_evidence"];
const STANCES = ["refutes", "supports", "not_relevant"];

const describeError = (error: FactCheckError) => ({ name: error.name, service: error.service, status: error.status });

const tests = {
  /** Full pipeline with stubbed APIs: proves the bundle runs in a service worker. */
  async offline({ transcript, tavilyFixture }: Args) {
    const { fetch } = fakeFetch({
      [JEV]: jevResponder((key) => {
        if (key.startsWith("checkable_")) return noulAnswer(key === "checkable_20" ? 0.95 : 0.1);
        if (key.startsWith("verdict")) return choiceAnswer("false", 0.9, VERDICTS);
        return choiceAnswer("refutes", 0.9, STANCES);
      }),
      "https://api.tavily.com/search": () => json(tavilyFixture),
    });
    const checker = createFactChecker({ typesafeApiKey: "test", tavilyApiKey: "tvly-test", fetch, maxRetries: 0 });
    const report = await checker.checkVideo({ video: { channel: "PragerU" }, transcript });
    return { model: report.model, labels: report.claims.map((c) => c.label) };
  },

  /** Real fetch to Jev with a bad key: proves the SDK reaches the API from the worker and maps 401. */
  async jevAuthProbe({ transcript }: Args) {
    try {
      await createFactChecker({ typesafeApiKey: "invalid-key", maxRetries: 0 }).checkVideo({ transcript });
      return { name: "no error" };
    } catch (error) {
      return describeError(error as FactCheckError);
    }
  },

  /** Real keyless Tavily search from the worker. */
  async tavilyLive() {
    const checker = createFactChecker({ typesafeApiKey: "unused", maxRetries: 0 });
    const evidence = await checker.searchEvidence("Richard Lindzen PragerU climate change video fact check");
    return { count: evidence.length, sources: evidence.map((e) => e.source) };
  },
};

Object.assign(globalThis, { factcheckTests: tests });
