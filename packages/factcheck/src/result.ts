import type { FactCheckResult, FactCheckVerdict, SubtitleSentence } from "./contract.js";
import { splitEvidenceSentences } from "./jev/verify.js";
import type { ClaimResult, Label, Language, SourceResult, Stance } from "./types.js";

export interface ResultContext {
  readonly videoId: string;
  readonly language: Language;
  /** How a `misleading` label is reported. */
  readonly misleadingAs: "misinformation" | "unknown";
}

interface Messages {
  readonly false: string;
  readonly misleading: string;
  readonly true: string;
  /** `publisher + statement + quote`, or `publisher + statement + end` without a quote. */
  readonly quoted: (publisher: string, statement: string, quote: string | undefined) => string;
  readonly noEvidence: string;
  readonly unclear: string;
  readonly failed: string;
}

const MESSAGES: Record<Language, Messages> = {
  en: {
    false: "says this claim is false",
    misleading: "says this claim is misleading",
    true: "supports this claim",
    quoted: (p, s, q) => (q ? `${p} ${s}: “${q}”` : `${p} ${s}.`),
    noEvidence: "No reliable source addressing this claim was found.",
    unclear: "The sources found don't clearly confirm or refute this claim.",
    failed: "This claim could not be checked.",
  },
  zh: {
    false: "指出此說法錯誤",
    misleading: "指出此說法有誤導之嫌",
    true: "支持此說法",
    quoted: (p, s, q) => (q ? `${p} ${s}：「${q}」` : `${p} ${s}。`),
    noEvidence: "找不到查核此說法的可靠來源。",
    unclear: "找到的來源無法明確證實或推翻此說法。",
    failed: "此說法查核失敗。",
  },
};

const STANCE_FOR: Partial<Record<Label, Stance>> = { false: "refutes", misleading: "refutes", true: "supports" };

function toVerdict(label: Label, misleadingAs: ResultContext["misleadingAs"]): FactCheckVerdict {
  if (label === "false") return "misinformation";
  if (label === "misleading") return misleadingAs;
  return label === "true" ? "verified" : "unknown";
}

/** Without a source that backs the label, Overlay would have nothing to link, so report `not_sure`. */
const backedLabel = (result: ClaimResult, backing: readonly SourceResult[]): Label =>
  STANCE_FOR[result.label] && backing.length === 0 ? "not_sure" : result.label;

/** Sources that back the label (or, without a label stance, any relevant ones): trusted first, then most confident. */
function backingSources(result: ClaimResult): SourceResult[] {
  const stance = STANCE_FOR[result.label];
  const matches = result.sources.filter((s) => (stance ? s.stance === stance : s.stance !== "not_relevant"));
  return [...matches].sort((a, b) => Number(b.trusted) - Number(a.trusted) || b.stanceConfidence - a.stanceConfidence);
}

const quoteOf = (source: SourceResult): string | undefined =>
  (source.quote ?? splitEvidenceSentences(source.text)[0] ?? source.text.slice(0, 200)).trim() || undefined;

function explain(result: ClaimResult, best: SourceResult | undefined, language: Language): string {
  const m = MESSAGES[language];
  if (result.error) return m.failed;
  if (result.label === "insufficient_evidence") return m.noEvidence;
  if (!best || result.label === "not_sure") return m.unclear;
  return m.quoted(best.source, m[result.label], quoteOf(best));
}

/** Map one checked claim to the README's `FactCheckResult`. */
export function toFactCheckResult(result: ClaimResult, ref: SubtitleSentence, context: ResultContext): FactCheckResult {
  const sources = backingSources(result);
  const label = backedLabel(result, sources);
  const shown = label === result.label ? result : { ...result, label };
  return {
    videoId: context.videoId,
    sentenceId: ref.id,
    startSeconds: ref.startSeconds,
    endSeconds: ref.endSeconds,
    sentence: ref.text,
    verdict: toVerdict(label, context.misleadingAs),
    // A finding nothing backs is no finding: don't report the unbacked label's confidence.
    confidence: label === result.label ? result.confidence : 0,
    explanation: explain(shown, sources[0], context.language),
    sources: sources.map((s) => ({ title: s.title || s.source, url: s.url })),
  };
}
