import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";
import { countCjk } from "../cjk.js";
import { UpstreamError } from "../errors.js";
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
const quoteKey = (i: number) => `${sourceKey(i)}_quote`;
const NO_QUOTE = "none";

const MAX_QUOTE_SENTENCES = 20;
const MAX_QUOTE_CHARS = 300;
const SENTENCE_BREAK = /(?<=[.!?])\s+|(?<=[。！？])\s*|\s*\[\.\.\.\]\s*/;

/** At least two words, or four CJK characters, so fragments like "ok." are not offered as quotes. */
const isSentence = (s: string) => s.split(/\s+/).length >= 2 || countCjk(s) >= 4;

/** Split a source's text into candidate quotes for Jev to choose from. */
export function splitEvidenceSentences(text: string): string[] {
  return text
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter(isSentence)
    .slice(0, MAX_QUOTE_SENTENCES)
    .map((s) => s.slice(0, MAX_QUOTE_CHARS));
}

const quoteQuestion = (i: number, sentences: readonly string[]) =>
  choice(`Which sentence of \`evidence.${sourceKey(i)}\` best states what it concludes about \`claim\`?`, {
    ...Object.fromEntries(sentences.map((s, j) => [`s${j}`, s])),
    [NO_QUOTE]: "No sentence says whether the claim is true or false",
  });

/**
 * Same shape as `ref/jev-api-payload.json`. `verdict_reversed` repeats the verdict with options
 * in reverse order, because Jev can lean toward the first option. `source_N_quote` picks the
 * sentence that best states each source's conclusion, for the explanation shown to users.
 */
export function buildVerificationRequest(claim: string, evidence: readonly Evidence[]) {
  return prepareVerification(claim, evidence).request;
}

/** The request plus the quote candidates per source, so answers map back to the same sentences. */
function prepareVerification(claim: string, evidence: readonly Evidence[]) {
  const reversed = Object.fromEntries(Object.entries(VERDICT_CRITERIA).reverse());
  const quotable = evidence.map((e) => splitEvidenceSentences(e.text));
  const questions: Record<string, ChoiceQuestion> = {
    verdict: choice(VERDICT_INSTRUCTIONS, VERDICT_CRITERIA),
    verdict_reversed: choice(VERDICT_INSTRUCTIONS, reversed),
    ...Object.fromEntries(
      evidence.map((_, i) => [stanceKey(i), choice(`What does \`evidence.${sourceKey(i)}\` say about \`claim\`?`, STANCE_CRITERIA)]),
    ),
    ...Object.fromEntries(
      quotable.flatMap((sentences, i) => (sentences.length > 0 ? [[quoteKey(i), quoteQuestion(i, sentences)]] : [])),
    ),
  };
  const state = {
    claim,
    evidence: Object.fromEntries(evidence.map((e, i) => [sourceKey(i), { source: e.source, text: e.text }])),
  };
  return { request: { state, questions }, quotable };
}

export interface Verification {
  readonly verdict: { readonly choice: Verdict; readonly confidence: number };
  readonly verdictReversed: { readonly choice: Verdict; readonly confidence: number };
  readonly sources: SourceResult[];
  readonly model: string;
  readonly inputTokens: number;
}

function readQuote(answers: Readonly<Record<string, unknown>>, i: number, sentences: readonly string[]): string | undefined {
  if (sentences.length === 0) return undefined;
  const options = [...sentences.map((_, j) => `s${j}`), NO_QUOTE];
  try {
    const picked = readChoice(answers[quoteKey(i)], quoteKey(i), options).choice;
    return picked === NO_QUOTE ? undefined : sentences[Number(picked.slice(1))];
  } catch (error) {
    // The quote only improves the explanation; a malformed answer falls back to the source's first sentence.
    if (error instanceof UpstreamError) return undefined;
    throw error;
  }
}

export async function verifyWithJev(
  jev: JevClient,
  claim: string,
  evidence: readonly Evidence[],
  signal?: AbortSignal,
): Promise<Verification> {
  const { request, quotable } = prepareVerification(claim, evidence);
  const result = await jev.ask(request.state, request.questions, signal);
  const sources = evidence.map((e, i): SourceResult => {
    const stance = readChoice(result.answers[stanceKey(i)], stanceKey(i), STANCES);
    return { ...e, stance: stance.choice, stanceConfidence: stance.confidence, quote: readQuote(result.answers, i, quotable[i] ?? []) };
  });
  return {
    verdict: readChoice(result.answers.verdict, "verdict", VERDICTS),
    verdictReversed: readChoice(result.answers.verdict_reversed, "verdict_reversed", VERDICTS),
    sources,
    model: result.model,
    inputTokens: result.inputTokens,
  };
}
