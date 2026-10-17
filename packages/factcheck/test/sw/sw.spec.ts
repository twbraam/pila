import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, test as base, type Worker } from "@playwright/test";

const extensionPath = fileURLToPath(new URL("./extension", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const args = { transcript: read("../../../../examples/transcripts/transcript.json"), tavilyFixture: read("../fixtures/tavily-lindzen.json") };

const test = base.extend<{ context: BrowserContext; worker: Worker }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const [existing] = context.serviceWorkers();
    await use(existing ?? (await context.waitForEvent("serviceworker")));
  },
});

type TestName = "offline" | "jevAuthProbe" | "tavilyLive";
const run = (worker: Worker, name: TestName) =>
  worker.evaluate(
    ([n, a]) => (globalThis as unknown as { factcheckTests: Record<string, (x: unknown) => Promise<unknown>> }).factcheckTests[n]!(a),
    [name, args] as const,
  );

test("runs the full pipeline inside an MV3 service worker", async ({ worker }) => {
  const result = (await run(worker, "offline")) as { model: string; labels: string[]; verdicts: string[] };
  expect(result.model).toBe("jev-1.13.0");
  expect(result.labels).toEqual(["false"]);
  expect(result.verdicts).toEqual(["misinformation"]);
});

test("reaches the real Jev API from the worker and reports a bad key as AuthError", async ({ worker }) => {
  expect(await run(worker, "jevAuthProbe")).toEqual({ name: "AuthError", service: "jev", status: 401 });
});

test("searches the real Tavily API from the worker (keyless)", async ({ worker }) => {
  const result = (await run(worker, "tavilyLive")) as { count: number; sources: string[] };
  expect(result.count).toBeGreaterThan(0);
});
