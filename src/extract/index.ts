import { writeFileSync } from "node:fs";
import { getTranscript, toPlainText } from "./transcript.js";
import { toSrt, toVtt } from "./format.js";

const FORMATS = ["srt", "vtt", "text", "json"] as const;
type Format = (typeof FORMATS)[number];

const USAGE = `Usage: npm run transcript -- <video-url-or-id> [options]

Options:
  --format srt|vtt|text|json   output format (default: srt)
  --out <file>                 write to a file instead of stdout
  --chunk <seconds>            clip length sent to Gemini (default: 1200)
  --duration <seconds>         video length; only needed if it can't be read from YouTube

Env:
  GEMINI_API_KEY   required (can also go in a .env file)
  GEMINI_MODEL     optional, defaults to gemini-2.5-flash`;

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
  const format = (flag(args, "--format") ?? "srt") as Format;

  if (!FORMATS.includes(format)) {
    console.error(`Unknown format "${format}". Use one of: ${FORMATS.join(", ")}`);
    process.exit(1);
  }

  // The target is the first arg that isn't a flag or a flag's value.
  const valueFlags = new Set(["--out", "--format", "--chunk", "--duration"]);
  const target = args.find(
    (a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]),
  );
  if (!target) {
    console.error(USAGE);
    process.exit(1);
  }

  const num = (name: string) => {
    const v = flag(args, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`${name} must be a positive number of seconds`);
      process.exit(1);
    }
    return n;
  };

  const started = performance.now();
  const { videoId, segments } = await getTranscript(target, {
    chunkSeconds: num("--chunk"),
    durationSeconds: num("--duration"),
  });
  console.error(
    `Total latency: ${((performance.now() - started) / 1000).toFixed(1)}s ` +
      `(${segments.length} segments)`,
  );

  const output = {
    srt: () => toSrt(segments),
    vtt: () => toVtt(segments),
    text: () => toPlainText(segments),
    json: () => JSON.stringify({ videoId, source: "gemini", segments }, null, 2),
  }[format]();

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
