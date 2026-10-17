import { writeFileSync } from "node:fs";
import { readTranscript } from './input';
import { factCheck } from "./factcheck.js";
import { report } from "./report.js";

const USAGE = `Usage: npm run factcheck -- <transcript.json> [options]

Input is the JSON written by: npm run extract -- <url> --out transcript.json
The whole transcript is read at once: first for what the video is trying to deliver
and its sentiment, then checked with Google grounding.

Options:
  --format text|json   text report (default): the video's message and sentiment, only the
                       NOT TRUE lines with timestamp, why and grounding sources, and whether
                       the message holds up; or the full JSON for every line
  --out <file>         write to a file instead of stdout

Env:
  GEMINI_API_KEY   required (can also go in a .env file)
  FACTCHECK_MODEL  optional, defaults to gemini-3.8-flash. Thinking is kept as low as the
                   model allows: off for 2.5 models, "low" for 3.x models`;

// Load .env if present (Node >= 20.12); ignore if missing.
try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const format = flag(args, "--format") ?? "text";
  const out = flag(args, "--out");

  if (format !== "text" && format !== "json") {
    console.error(`Unknown format "${format}". Use text or json`);
    process.exit(1);
  }

  const valueFlags = new Set(["--format", "--out"]);
  const file = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ''));
  if (!file) {
    console.error(USAGE);
    process.exit(1);
  }

  const input = await readTranscript(file);
  const segments = input.sentences;
  const videoId = input.videoId;
  const result = await factCheck(input);

  const { overviewMs, groundingMs, judgingMs, totalMs } = result.latency;
  const other = totalMs - overviewMs - groundingMs - judgingMs;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`.padStart(7);
  const pct = (ms: number) => `${Math.round((ms / totalMs) * 100)}%`.padStart(4);
  console.error(
    [
      "",
      `Latency profile (${result.model}, thinking ${result.thinking}, ${segments.length} lines, ${result.sources.length} sources)`,
      `  Overview, whole text (no tools) ${sec(overviewMs)} ${pct(overviewMs)}`,
      `  Google grounding (search call)  ${sec(groundingMs)} ${pct(groundingMs)}`,
      `  Gemini judging (no tools)       ${sec(judgingMs)} ${pct(judgingMs)}`,
      `  Other (network, parsing)        ${sec(other)} ${pct(other)}`,
      `  Total                           ${sec(totalMs)}`,
      "",
    ].join("\n"),
  );

  const output = format === "json" ? JSON.stringify({ videoId, ...result }, null, 2) : report(result);

  if (out) {
    writeFileSync(out, output);
    console.error(`Wrote ${out}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
