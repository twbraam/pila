import { readFileSync, writeFileSync } from "node:fs";
import type { TranscriptSegment } from "../extract/transcript.js";
import { DEFAULT_THRESHOLD, screen } from "./screen.js";

const USAGE = `Usage: npm run screen -- <transcript.json> [options]

Scores every sentence for how suspicious it looks (0-5) and lists only the ones at or
above the threshold, marked nextStep "verify_claim" for the Google-grounded fact-check.
Screening never decides what is true (truthStatus stays "not_assessed").

Options:
  --threshold <n>   score at or above which a sentence needs review (default: ${DEFAULT_THRESHOLD})
  --out <file>      write the JSON to a file instead of stdout
  --all             list every sentence, not just the ones at or above the threshold

Env:
  GEMINI_API_KEY   required (can also go in a .env file)
  SCREEN_MODEL     optional, defaults to gemini-3.5-flash-lite`;

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
  const out = flag(args, "--out");
  const th = flag(args, "--threshold");
  const threshold = th === undefined ? undefined : Number(th);
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) {
    console.error("--threshold must be a number of 0 or more");
    process.exit(1);
  }

  const valueFlags = new Set(["--out", "--threshold"]);
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

  const result = await screen(segments, { videoId, threshold });
  const flagged = result.targets.filter((t) => t.suspectedIssue);
  console.error(
    `Screened ${result.targets.length} sentences with ${result.model} in ` +
      `${(result.latencyMs / 1000).toFixed(1)}s: ${flagged.length} marked verify_claim`,
  );

  // By default only the sentences at or above the threshold are listed.
  const listed = args.includes("--all") ? result.targets : flagged;
  const output = JSON.stringify(
    {
      ...result,
      totalSentences: result.targets.length,
      flaggedCount: flagged.length,
      targets: listed,
    },
    null,
    2,
  );
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
