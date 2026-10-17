import { clock, type FactCheckResult } from "./factcheck.js";

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ");

/**
 * Text report: what the video is trying to deliver, then only the lines
 * grounding found NOT true (with timestamp, why and sources), then whether
 * the main message holds up. True and unchecked lines are left out.
 */
export function report(r: FactCheckResult): string {
  const { overview, segments } = r;
  const notTruth = segments.filter((s) => s.verdict === "not_truth");
  const count = (v: string) => segments.filter((s) => s.verdict === v).length;

  const head = [
    "WHAT THE VIDEO IS TRYING TO DELIVER",
    `  ${overview.mainMessage}`,
    `  Sentiment: ${overview.sentiment}${overview.tone ? ` (tone: ${overview.tone})` : ""}`,
    `  Summary: ${overview.summary}`,
    ...(overview.keyClaims.length ? ["  Key claims:", ...overview.keyClaims.map((c) => `    - ${c}`)] : []),
  ].join("\n");

  const lines = notTruth.length
    ? notTruth
        .map((s) => {
          const sources = s.sources.map((x) => `    - ${x.title}: ${x.uri}`).join("\n");
          return `[${clock(s.start)}] "${oneLine(s.text)}"\n  why not true: ${s.reason}\n  grounding sources:\n${sources}`;
        })
        .join("\n\n")
    : "No lines were found to be untrue.";

  const summary =
    `${notTruth.length} not true, ${count("truth")} true, ${count("unchecked")} unchecked ` +
    `(of ${segments.length} lines)`;

  return [
    head,
    `NOT TRUE LINES\n${lines}`,
    `DOES THE MESSAGE HOLD UP?\n  ${r.messageAssessment}`,
    summary,
  ].join("\n\n");
}
