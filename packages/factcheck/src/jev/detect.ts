import { noul, type NoulQuestion } from "@typesafe-ai/sdk";
import { mapLimit } from "../concurrency.js";
import type { Claim, Sentence } from "../types.js";
import { readNoul } from "./answers.js";
import type { JevClient } from "./client.js";

const CHECKABLE_CRITERIA = {
  true: "States a checkable fact: a number, an event, a quote, a scientific finding, or a cause and effect",
  false: "An opinion, a prediction, a question, an introduction, or too vague to check",
};

const SUSPICIOUS_CRITERIA = {
  true: "Contradicts what experts and reliable sources generally accept",
  false: "Agrees with consensus, is personal, or makes no factual claim",
};

const checkableKey = (i: number) => `checkable_${i}`;
const suspiciousKey = (i: number) => `suspicious_${i}`;

/**
 * Two `noul`s per sentence: is it checkable, and does it contradict consensus. Jev can't verify
 * facts, but in live tests the second score ranked the reviewed false claims first. Indexes are
 * local to `sentences`.
 */
export function buildDetectionRequest(sentences: readonly Sentence[]) {
  const questions: Record<string, NoulQuestion> = Object.fromEntries(
    sentences.flatMap((_, i) => [
      [checkableKey(i), noul(`Is \`sentences[${i}]\` a specific factual claim that could be checked against outside sources?`, CHECKABLE_CRITERIA)],
      [
        suspiciousKey(i),
        noul(`Does \`sentences[${i}]\` state something that contradicts established scientific or historical consensus?`, SUSPICIOUS_CRITERIA),
      ],
    ]),
  );
  return { state: { sentences: sentences.map((s) => s.text) }, questions };
}

export interface FindClaimsOptions {
  readonly threshold: number;
  readonly maxClaims: number;
  readonly maxPerRequest: number;
  readonly concurrency: number;
  readonly signal?: AbortSignal | undefined;
}

export interface FoundClaims {
  readonly claims: Claim[];
  readonly model: string;
  readonly inputTokens: number;
}

const chunk = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * Ask Jev which sentences are checkable claims. Keeps those at or above `threshold`, takes the
 * `maxClaims` most suspicious, and returns them in video order.
 */
export async function findClaims(jev: JevClient, sentences: readonly Sentence[], options: FindClaimsOptions): Promise<FoundClaims> {
  const batches = await mapLimit(chunk(sentences, options.maxPerRequest), options.concurrency, async (batch) => {
    const { state, questions } = buildDetectionRequest(batch);
    const result = await jev.ask(state, questions, options.signal);
    const scored = batch.map(
      (s, i): Claim => ({
        ...s,
        checkable: readNoul(result.answers[checkableKey(i)], checkableKey(i)),
        suspicious: readNoul(result.answers[suspiciousKey(i)], suspiciousKey(i)),
      }),
    );
    return { scored, model: result.model, inputTokens: result.inputTokens };
  });

  const claims = batches
    .flatMap((b) => b.scored)
    .filter((c) => c.checkable >= options.threshold)
    .sort((a, b) => b.suspicious - a.suspicious)
    .slice(0, options.maxClaims)
    .sort((a, b) => a.index - b.index);

  return {
    claims,
    model: batches[0]?.model ?? jev.model,
    inputTokens: batches.reduce((sum, b) => sum + b.inputTokens, 0),
  };
}
