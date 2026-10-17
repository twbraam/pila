/**
 * Fact-check a saved transcript from the terminal.
 *
 *   npm run check-video -w @pila/factcheck -- ../../ref/transcript.json --channel PragerU --title "..."
 *
 * Reads TYPESAFE_API_KEY and TAVILY_API_KEY from the environment or the repo's .env.
 * Without TAVILY_API_KEY, Tavily's keyless mode is used.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createFactChecker, type FactCheckError, type Language, type VideoReport } from "../src/index.js";

const ENV_FILE = resolve(import.meta.dirname, "../../../.env");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string" },
    channel: { type: "string" },
    id: { type: "string" },
    lang: { type: "string" },
    "max-claims": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function printReport(report: VideoReport): void {
  const out = (line = "") => process.stdout.write(`${line}\n`);
  out(`Model ${report.model} · language ${report.language} · ${report.claims.length} claims`);
  out(`Usage: ${report.usage.jevInputTokens} Jev input tokens, ${report.usage.tavilyCredits} Tavily credits, ${report.usage.durationMs} ms`);
  if (report.videoReviews.length > 0) {
    out("\nReviews of this video:");
    for (const r of report.videoReviews) out(`  - ${r.source}${r.trusted ? " (trusted)" : ""}: ${r.url}`);
  }
  for (const c of report.claims) {
    out(`\n[${formatTime(c.claim.start)}] ${c.label.toUpperCase()} (${c.confidence.toFixed(2)})  ${c.claim.text}`);
    if (c.error) out(`  error: ${c.error.name}: ${c.error.message}`);
    if (c.jev) out(`  jev: verdict=${c.jev.verdict} (${c.jev.verdictConfidence.toFixed(2)}), reversed=${c.jev.verdictReversed}`);
    for (const s of c.sources) out(`  - ${s.stance} (${s.stanceConfidence.toFixed(2)}) ${s.source}: ${s.url}`);
  }
}

async function main(): Promise<number> {
  const [file] = positionals;
  if (!file) {
    process.stderr.write("Usage: check-video <transcript.json> [--title T] [--channel C] [--id ID] [--lang en|zh] [--max-claims N] [--json]\n");
    return 2;
  }
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  const checker = createFactChecker({
    typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "",
    tavilyApiKey: process.env.TAVILY_API_KEY,
    limits: { maxClaims: values["max-claims"] ? Number(values["max-claims"]) : undefined },
  });
  const report = await checker.checkVideo(
    {
      video: { id: values.id, title: values.title, channel: values.channel },
      transcript: JSON.parse(readFileSync(resolve(file), "utf8")),
      language: values.lang as Language | undefined,
    },
    { onProgress: (e) => process.stderr.write(`… ${e.stage} ${e.done}/${e.total}\n`) },
  );

  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  return 0;
}

// Set exitCode instead of calling process.exit, so piped stdout is flushed before exit.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: FactCheckError) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  },
);
