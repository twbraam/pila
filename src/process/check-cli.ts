import { readFileSync, writeFileSync } from "node:fs";
import type { TranscriptSegment } from "../extract/transcript.js";
import { check, report } from "./check.js";
import { DEFAULT_THRESHOLD } from "./screen.js";

const USAGE = `Usage: npm run check -- <transcript.json> [options]

Screens every sentence for suspicion, sends only the ones at or above the threshold to
Google grounding, and prints only the sentences found NOT TRUE, with timestamp, why and
sources. Progress and the latency profile go to stderr.

Input is the JSON written by: npm run transcript -- <url> --format json --out transcript.json

Options:
  --threshold <n>      suspicion score (0-5) at or above which a sentence is verified (default: ${DEFAULT_THRESHOLD})
  --format text|json   text (default): only the not true sentences; json: every flagged
                       sentence with its verdict, plus counts and latency
  --out <file>         write to a file instead of stdout

Env:
  GEMINI_API_KEY   required (can also go in a .env file)
  SCREEN_MODEL     optional, defaults to gemini-3.5-flash-lite
  FACTCHECK_MODEL  optional, defaults to gemini-3.8-flash`;

// Load .env if present (Node >= 20.12); ignore if missing.
try {
  process.loadEnvFile();
} catch {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const format = flag(args, "--format") ?? "text";
  const out = flag(args, "--out");
  const th = flag(args, "--threshold");
  const threshold = th === undefined ? undefined : Number(th);

  if (format !== "text" && format !== "json") {
    console.error(`Unknown format "${format}". Use text or json`);
    process.exit(1);
  }
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) {
    console.error("--threshold must be a number of 0 or more");
    process.exit(1);
  }

  const valueFlags = new Set(["--format", "--out", "--threshold"]);
  const file = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));
  if (!file) {
    console.error(USAGE);
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(file, "utf8")) as
    | TranscriptSegment[]
    | { videoId?: string; segments: TranscriptSegment[] };
  const segments = Array.isArray(input) ? input : input.segments;
  const videoId = Array.isArray(input) ? null : (input.videoId ?? null);
  if (!Array.isArray(segments) || segments.length === 0) {
    console.error(`No transcript segments found in ${file}`);
    process.exit(1);
  }

  const result = await check(segments, { videoId, threshold });

  const { screenMs, groundingMs, judgingMs, totalMs } = result.latency;
  const other = totalMs - screenMs - groundingMs - judgingMs;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`.padStart(7);
  const pct = (ms: number) => `${Math.round((ms / totalMs) * 100)}%`.padStart(4);
  const { counts } = result;
  console.error(
    [
      "",
      `Latency profile (screen ${result.models.screen}; verify ${result.models.verify}, thinking ${result.models.verifyThinking})`,
      `  Screening, all sentences        ${sec(screenMs)} ${pct(screenMs)}`,
      `  Google grounding (flagged only) ${sec(groundingMs)} ${pct(groundingMs)}`,
      `  Gemini judging (no tools)       ${sec(judgingMs)} ${pct(judgingMs)}`,
      `  Other (network, parsing)        ${sec(other)} ${pct(other)}`,
      `  Total                           ${sec(totalMs)}`,
      "",
      `${result.totalSentences} sentences, ${result.flaggedCount} flagged at threshold ${result.threshold}: ` +
        `${counts.not_truth} not true, ${counts.truth} true, ${counts.unchecked} unchecked`,
      "",
    ].join("\n"),
  );

  const output = format === "json" ? JSON.stringify(result, null, 2) : report(result);

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
