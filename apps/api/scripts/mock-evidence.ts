/**
 * Regenerates `src/factcheck/mock-results/<videoId>.evidence.json` from the recorded evidence runs:
 *   npx tsx scripts/mock-evidence.ts
 * A test checks the committed files still match `results/`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildEvidenceSources, type EvidenceRun, type EvidenceSources, type TavilyResponse } from "../src/factcheck/mock-evidence.js";

export const MOCK_EVIDENCE_RUNS: Readonly<Record<string, string>> = {
  "OwqIy8Ikv-c": "results/OwqIy8Ikv-c/evidence-20261017T080238219Z",
  "7wFWgopJP5Q": "results/7wFWgopJP5Q/evidence-20261017T080216689Z",
};

const REPO = new URL("../../../", import.meta.url);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, REPO), "utf8")) as T;

export function loadEvidenceRun(videoId: string): { readonly evidenceRun: string; readonly sources: EvidenceSources } {
  const dir = MOCK_EVIDENCE_RUNS[videoId];
  if (!dir) throw new Error(`No evidence run for ${videoId}`);
  const evidence = readJson<EvidenceRun>(`${dir}/evidence.json`);
  const tavily = Object.fromEntries(evidence.groups.map((g) => [g.id, readJson<TavilyResponse>(`${dir}/${g.id}/tavily-response.json`)]));
  return { evidenceRun: dir, sources: buildEvidenceSources(evidence, tavily) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const videoId of Object.keys(MOCK_EVIDENCE_RUNS)) {
    const out = new URL(`../src/factcheck/mock-results/${videoId}.evidence.json`, import.meta.url);
    writeFileSync(out, `${JSON.stringify(loadEvidenceRun(videoId), null, 2)}\n`);
  }
}
