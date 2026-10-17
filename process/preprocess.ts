import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getEncoding } from 'js-tiktoken';
import { assertTranscript, type Transcript, type TranscriptSentence } from '../shared/transcript';

export const ROOT = resolve(__dirname, '..');
export type DecisionType = 'noul' | 'score';
export type Language = 'en' | 'zh-TW';
export interface Options {
  transcript: string;
  language: 'auto' | Language;
  batchSize: number;
  contextTokens: number;
  decisionType: DecisionType;
  threshold: number;
  outdir: string | undefined;
}
export interface Question {
  type: DecisionType;
  instructions: string;
  criteria: Record<string, string> | string[];
}
type ResolvedOptions = Omit<Options, 'language'> & { language: Language };
interface ProcessingSentence extends TranscriptSentence {
  sourceSentenceId: string;
  partIndex: number;
  partCount: number;
}
export interface Target extends ProcessingSentence {
  questionPrefix: string;
}
export interface Payload {
  model: string;
  state: {
    videoId: string;
    language: Language;
    transcriptSource: 'manual_caption';
    screeningPolicy: { sharedInstructions: string; decisionInstructions: string };
    targets: Target[];
    context: {
      sentences: { id: string; text: string }[];
      estimatedTokens: number;
      tokenBudget: number;
      tokenizerEstimate: string;
      atTranscriptStart: boolean;
      atTranscriptEnd: boolean;
    };
  };
  questions: Record<string, Question>;
}
export interface Prepared {
  videoId: string;
  source: string;
  sourceSha256: string;
  sentenceCount: number;
  targetCount: number;
  language: Language;
  languageSelection: 'auto' | 'override';
  languageDetection: ReturnType<typeof detectLanguage>;
  options: ResolvedOptions;
  requests: Payload[];
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

export function readOptions(args = process.argv.slice(2)): Options {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      'batch-size': { type: 'string', default: '64' },
      'context-tokens': { type: 'string', default: '4000' },
      'decision-type': { type: 'string', default: 'score' },
      threshold: { type: 'string' },
      language: { type: 'string', default: 'auto' },
      outdir: { type: 'string' },
    },
  });
  if (positionals.length !== 1) {
    throw new Error('Supply one transcript JSON file. Options: --batch-size 64 --context-tokens 4000 --decision-type score --threshold 2 --language auto --outdir <new-directory>');
  }
  const decisionType = values['decision-type'];
  const language = values.language;
  if (decisionType !== 'score' && decisionType !== 'noul') throw new Error('decision-type must be score or noul');
  if (language !== 'auto' && language !== 'en' && language !== 'zh-TW') throw new Error('language must be auto, en or zh-TW');
  const batchSize = Number(values['batch-size']);
  const contextTokens = Number(values['context-tokens']);
  for (const [name, value] of [['batch-size', batchSize], ['context-tokens', contextTokens]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const threshold = values.threshold === undefined ? (decisionType === 'score' ? 2 : 0.7) : Number(values.threshold);
  const upper = decisionType === 'score' ? 3 : 1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > upper) {
    throw new Error(`threshold must be between 0 and ${upper}`);
  }
  return {
    transcript: resolve(positionals[0]!), language, batchSize, contextTokens, decisionType,
    threshold, outdir: values.outdir,
  };
}

function loadPrompt(options: ResolvedOptions) {
  const path = resolve(ROOT, 'prompts', `jev.${options.language}.json`);
  const prompt = object(JSON.parse(readFileSync(path, 'utf8')), path);
  const model = string(prompt.model, 'model');
  const shared = string(prompt.shared_instructions, 'shared_instructions');
  const target = string(prompt.target_instructions, 'target_instructions');
  if (!shared.includes('{target_id}') || !target.includes('{target_id}')) {
    throw new Error('Shared and target instructions must contain {target_id}');
  }
  const definition = object(object(prompt.decision_types, 'decision_types')[options.decisionType], 'Decision definition');
  if (definition.type !== options.decisionType) throw new Error('Prompt decision type mismatch');
  const instructions = string(definition.instructions, 'Decision instructions');
  const criteria = definition.criteria;
  if (options.decisionType === 'score') {
    if (!Array.isArray(criteria) || criteria.length !== 4 || !criteria.every((v) => typeof v === 'string')) {
      throw new Error('score requires four rubric levels');
    }
  } else {
    const choices = object(criteria, 'noul criteria');
    if (Object.keys(choices).length !== 2 || typeof choices.true !== 'string' || typeof choices.false !== 'string') {
      throw new Error('noul criteria must contain true and false');
    }
  }
  return { model, shared, target, question: { type: options.decisionType, instructions, criteria } as Question };
}

function buildRequests(transcript: { videoId: string; sentences: ProcessingSentence[] }, options: ResolvedOptions): Payload[] {
  const sentences = transcript.sentences;
  const encoder = getEncoding('cl100k_base');
  const count = (first: number, last: number) => {
    // Keep estimator serialization consistent with the earlier Python prototype.
    const serialized = `[${sentences.slice(first, last).map((s) =>
      `{"id": ${JSON.stringify(s.id)}, "text": ${JSON.stringify(s.text)}}`).join(', ')}]`;
    return encoder.encode(serialized, [], []).length;
  };
  const prompt = loadPrompt(options);
  const requests: Payload[] = [];
  let offset = 0;
  while (offset < sentences.length) {
    let size = Math.min(options.batchSize, sentences.length - offset);
    let first = Math.max(0, offset - 2);
    let last = Math.min(sentences.length, offset + size + 2);
    while (size > 1 && count(first, last) > options.contextTokens) {
      size--;
      last = Math.min(sentences.length, offset + size + 2);
    }
    if (count(first, last) > options.contextTokens) {
      throw new Error(`Target and neighboring context at ${offset} exceed context-tokens; increase the budget or revise sentence assembly. No text was truncated.`);
    }
    const targets = sentences.slice(offset, offset + size);
    const blocked = new Set<string>();
    let turn = 'before';
    while (blocked.size < 2) {
      const side = turn;
      turn = side === 'before' ? 'after' : 'before';
      if (blocked.has(side)) continue;
      const a = side === 'before' ? first - 1 : first;
      const b = side === 'before' ? last : last + 1;
      if (a < 0 || b > sentences.length || count(a, b) > options.contextTokens) blocked.add(side);
      else { first = a; last = b; }
    }
    const questions: Record<string, Question> = {};
    targets.forEach((target, index) => {
      questions[`target_${index}_suspicion`] = {
        ...prompt.question, instructions: prompt.target.replaceAll('{target_id}', target.id),
      };
    });
    requests.push({
      model: prompt.model,
      state: {
        videoId: transcript.videoId, language: options.language, transcriptSource: 'manual_caption',
        screeningPolicy: {
          sharedInstructions: prompt.shared.replaceAll('{target_id}', 'specified by the current question'),
          decisionInstructions: prompt.question.instructions,
        },
        targets: targets.map((target, index) => ({ ...target, questionPrefix: `target_${index}_` })),
        context: {
          sentences: sentences.slice(first, last).map(({ id, text }) => ({ id, text })),
          estimatedTokens: count(first, last), tokenBudget: options.contextTokens,
          tokenizerEstimate: "cl100k_base; not Jev's verified tokenizer",
          atTranscriptStart: first === 0, atTranscriptEnd: last === sentences.length,
        },
      },
      questions,
    });
    offset += size;
  }
  return requests;
}

function detectLanguage(transcript: Transcript) {
  const text = transcript.sentences.map((sentence) => sentence.text).join('\n');
  const hanCharacters = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latinLetters = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const hanRatio = hanCharacters / Math.max(1, hanCharacters + latinLetters);
  // Route Chinese text to Traditional-Chinese instructions; do not rewrite the transcript.
  const language: Language = hanCharacters > 0 && hanRatio >= 0.2 ? 'zh-TW' : 'en';
  return { language, method: 'unicode-script-ratio', hanCharacters, latinLetters, hanRatio };
}

function prepareSentences(transcript: Transcript, language: Language, contextTokens: number): ProcessingSentence[] {
  const encoder = getEncoding('cl100k_base');
  const budget = Math.max(1, Math.min(512, Math.floor(contextTokens / 8)));
  const count = (text: string) => encoder.encode(text, [], []).length;
  const result: ProcessingSentence[] = [];
  for (const sentence of transcript.sentences) {
    const parts: string[] = [];
    if (language === 'zh-TW' && count(sentence.text) > budget) {
      // Chinese captions may contain paragraphs without sentence punctuation.
      // Split only oversized text, preserving every character and the parent's time bounds.
      const points = Array.from(sentence.text);
      let start = 0;
      while (start < points.length) {
        let low = start + 1;
        let high = points.length;
        let end = start;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (count(points.slice(start, middle).join('')) <= budget) {
            end = middle;
            low = middle + 1;
          } else high = middle - 1;
        }
        if (end === start) throw new Error(`Token budget cannot fit a character in ${sentence.id}`);
        if (end < points.length) {
          const earliest = start + Math.floor((end - start) * 0.75);
          for (let cut = end; cut > earliest; cut--) {
            if (/[。！？!?；;，,\s]/u.test(points[cut - 1]!)) {
              end = cut;
              break;
            }
          }
        }
        while (end > start && count(points.slice(start, end).join('')) > budget) end--;
        if (end === start) throw new Error(`Cannot split ${sentence.id} within the token budget`);
        parts.push(points.slice(start, end).join(''));
        start = end;
      }
    } else parts.push(sentence.text);
    parts.forEach((text, index) => result.push({
      ...sentence, text,
      id: parts.length === 1 ? sentence.id : `${sentence.id}::part-${index + 1}`,
      sourceSentenceId: sentence.id, partIndex: index + 1, partCount: parts.length,
    }));
  }
  if (new Set(result.map((s) => s.id)).size !== result.length) throw new Error('Split target IDs collide');
  return result;
}

export function prepareTranscript(options: Options): Prepared {
  const raw = readFileSync(options.transcript);
  const transcript: unknown = JSON.parse(raw.toString('utf8'));
  assertTranscript(transcript);
  if (!transcript.sentences.length) throw new Error('Transcript has no sentences');
  const languageDetection = detectLanguage(transcript);
  const language = options.language === 'auto' ? languageDetection.language : options.language;
  const resolved: ResolvedOptions = { ...options, language };
  const sentences = prepareSentences(transcript, languageDetection.language, options.contextTokens);
  return {
    videoId: transcript.videoId, source: options.transcript,
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    sentenceCount: transcript.sentences.length, targetCount: sentences.length,
    language, languageSelection: options.language === 'auto' ? 'auto' : 'override',
    languageDetection, options: resolved,
    requests: buildRequests({ videoId: transcript.videoId, sentences }, resolved),
  };
}

export function saveJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
export function writeCalls(prepared: Prepared): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const outdir = prepared.options.outdir
    ? resolve(prepared.options.outdir) : resolve(ROOT, 'results', prepared.videoId, stamp);
  mkdirSync(dirname(outdir), { recursive: true });
  mkdirSync(outdir); // Refuse existing directories so stale calls cannot survive a new run.
  mkdirSync(resolve(outdir, 'calls'));
  prepared.requests.forEach((payload, index) => {
    saveJson(resolve(outdir, 'calls', `${String(index).padStart(4, '0')}.json`), payload);
  });
  const { requests: _requests, ...metadata } = prepared;
  saveJson(resolve(outdir, 'manifest.json'), {
    ...metadata, status: 'prepared', totalRequests: prepared.requests.length, completedRequests: 0,
  });
  return outdir;
}

if (require.main === module) {
  try {
    const prepared = prepareTranscript(readOptions());
    const outdir = writeCalls(prepared);
    console.log(`Prepared ${prepared.targetCount} targets from ${prepared.sentenceCount} sentences / ${prepared.requests.length} calls (${prepared.language}) → ${outdir}; no API calls.`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
