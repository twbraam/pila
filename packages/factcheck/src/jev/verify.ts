import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";
import type { Evidence, SourceResult, Stance, Verdict } from "../types.js";
import { readChoice } from "./answers.js";
import type { JevClient } from "./client.js";

export const VERDICT_CRITERIA: Readonly<Record<Verdict, string>> = {
  false: "The evidence shows the claim is false, fabricated, or falsely attributed",
  misleading: "The evidence shows the claim has some truth but distorts, exaggerates, or leaves out important context",
  true: "The evidence confirms the claim",
  insufficient_evidence: "The evidence is not relevant or not enough to confirm or refute the claim",
};

export const STANCE_CRITERIA: Readonly<Record<Stance, string>> = {
  refutes: "The source says the claim is false, fake, or misleading",
  supports: "The source says the claim is true",
  not_relevant: "The source does not say whether the claim is true or false",
};

const VERDICTS = Object.keys(VERDICT_CRITERIA) as Verdict[];
const STANCES = Object.keys(STANCE_CRITERIA) as Stance[];
const VERDICT_INSTRUCTIONS = "Based only on `evidence`, is `claim` true or false?";

const sourceKey = (i: number) => `source_${i + 1}`;
const stanceKey = (i: number) => `${sourceKey(i)}_stance`;

/**
 * Same shape as `ref/jev-api-payload.json`. `verdict_reversed` repeats the verdict with options
 * in reverse order, because Jev can lean toward the first option.
 */
export function buildVerificationRequest(claim: string, evidence: readonly Evidence[]) {
  const reversed = Object.fromEntries(Object.entries(VERDICT_CRITERIA).reverse());
  const questions: Record<string, ChoiceQuestion> = {
    verdict: choice(VERDICT_INSTRUCTIONS, VERDICT_CRITERIA),
    verdict_reversed: choice(VERDICT_INSTRUCTIONS, reversed),
    ...Object.fromEntries(
      evidence.map((_, i) => [stanceKey(i), choice(`What does \`evidence.${sourceKey(i)}\` say about \`claim\`?`, STANCE_CRITERIA)]),
    ),
  };
  const state = {
    claim,
    evidence: Object.fromEntries(evidence.map((e, i) => [sourceKey(i), { source: e.source, text: e.text }])),
  };
  return { state, questions };
}

export interface Verification {
  readonly verdict: { readonly choice: Verdict; readonly confidence: number };
  readonly verdictReversed: { readonly choice: Verdict; readonly confidence: number };
  readonly sources: SourceResult[];
  readonly model: string;
  readonly inputTokens: number;
}

export async function verifyWithJev(
  jev: JevClient,
  claim: string,
  evidence: readonly Evidence[],
  signal?: AbortSignal,
): Promise<Verification> {
  const { state, questions } = buildVerificationRequest(claim, evidence);
  const result = await jev.ask(state, questions, signal);
  const sources = evidence.map((e, i): SourceResult => {
    const stance = readChoice(result.answers[stanceKey(i)], stanceKey(i), STANCES);
    return { ...e, stance: stance.choice, stanceConfidence: stance.confidence };
  });
  return {
    verdict: readChoice(result.answers.verdict, "verdict", VERDICTS),
    verdictReversed: readChoice(result.answers.verdict_reversed, "verdict_reversed", VERDICTS),
    sources,
    model: result.model,
    inputTokens: result.inputTokens,
  };
}
