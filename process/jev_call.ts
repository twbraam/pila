import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  ROOT, object, prepareTranscript, readOptions, saveJson, writeCalls,
  type Language, type Options, type Payload,
} from './preprocess';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const KEY_NAMES = ['TYPESAFE_API_KEY', 'JEV_API', 'JEV_API_KEY', 'TYPE_SAFE_API_KEY'];
const PLACEHOLDERS = new Set(['your_typesafe_api_key_here', 'your_key_here']);

function loadApiKey(): string {
  const find = (values: Record<string, string | undefined>) => {
    for (const name of KEY_NAMES) {
      const value = values[name]?.trim();
      if (value && !PLACEHOLDERS.has(value)) return value;
    }
    return '';
  };
  const ambient = find(process.env);
  if (ambient) return ambient;
  const path = resolve(ROOT, '.env');
  return existsSync(path) ? find(parseEnv(readFileSync(path, 'utf8'))) : '';
}

export async function callJev(apiKey: string, payload: Payload): Promise<Record<string, unknown>> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(70_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000).replaceAll(apiKey, '[REDACTED]');
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return object(await response.json(), 'Jev response');
}

export interface SegmentResult {
  videoId: string;
  language: Language;
  sentenceId: string;
  targetId: string;
  partIndex: number;
  partCount: number;
  timestampPrecision: 'source_sentence';
  text: string;
  start: number;
  end: number;
  screeningType: 'score' | 'noul';
  suspicionScore: number;
  reviewThreshold: number;
  suspectedIssue: boolean;
  nextStep: 'verify_claim' | 'not_prioritized';
  truthStatus: 'not_assessed';
}

export function summarize(payload: Payload, response: Record<string, unknown>, threshold: number): SegmentResult[] {
  const answers = object(response.answers, 'Jev answers');
  const scores = new Map<string, number>();
  for (const [name, question] of Object.entries(payload.questions)) {
    const answer = object(answers[name], `Answer ${name}`);
    if (answer.type !== question.type) throw new Error(`Answer type mismatch: ${name}`);
    const value = answer[question.type];
    const upper = question.type === 'score' ? 3 : 1;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > upper) {
      throw new Error(`Invalid ${question.type} value: ${name}`);
    }
    scores.set(name, value);
  }
  return payload.state.targets.map((target) => {
    const name = `${target.questionPrefix}suspicion`;
    const question = payload.questions[name];
    const value = scores.get(name);
    if (!question || value === undefined) throw new Error(`Missing target result: ${target.id}`);
    const suspected = value >= threshold;
    return {
      videoId: payload.state.videoId, language: payload.state.language,
      sentenceId: target.sourceSentenceId, targetId: target.id,
      partIndex: target.partIndex, partCount: target.partCount, timestampPrecision: 'source_sentence',
      text: target.text,
      start: target.start, end: target.end, screeningType: question.type,
      suspicionScore: value, reviewThreshold: threshold, suspectedIssue: suspected,
      nextStep: suspected ? 'verify_claim' : 'not_prioritized', truthStatus: 'not_assessed',
    };
  });
}

export async function run(options: Options): Promise<string> {
  const prepared = prepareTranscript(options);
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error('API key missing from environment or repository-root .env');
  const outdir = writeCalls(prepared);
  console.log(`${prepared.targetCount} targets from ${prepared.sentenceCount} sentences / ${prepared.requests.length} calls (${prepared.language}) → ${outdir}`);
  mkdirSync(resolve(outdir, 'responses'));
  const { requests, ...metadata } = prepared;
  const manifest = {
    ...metadata, status: 'prepared', totalRequests: requests.length,
    completedRequests: 0, apiSeconds: 0,
    requestStats: [] as { requestIndex: number; apiSeconds: number; targets: number; usage: unknown }[],
    error: undefined as string | undefined,
  };
  saveJson(resolve(outdir, 'manifest.json'), manifest);
  const rows: SegmentResult[] = [];
  try {
    for (const [index, payload] of requests.entries()) {
      const start = performance.now();
      const response = await callJev(apiKey, payload);
      const elapsed = (performance.now() - start) / 1000;
      manifest.apiSeconds += elapsed;
      manifest.requestStats.push({
        requestIndex: index, apiSeconds: elapsed, targets: payload.state.targets.length,
        usage: response.usage ?? {},
      });
      saveJson(resolve(outdir, 'responses', `${String(index).padStart(4, '0')}.json`), response);
      rows.push(...summarize(payload, response, options.threshold));
      manifest.completedRequests++;
      saveJson(resolve(outdir, 'results.json'), { status: 'partial', targets: rows });
      saveJson(resolve(outdir, 'manifest.json'), manifest);
      console.log(`Completed ${index + 1}/${requests.length} (${elapsed.toFixed(2)}s)`);
    }
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, '[REDACTED]');
    saveJson(resolve(outdir, 'manifest.json'), manifest);
    throw new Error(`Run stopped; partial artifacts: ${outdir}. ${manifest.error}`);
  }
  manifest.status = 'completed';
  saveJson(resolve(outdir, 'manifest.json'), manifest);
  const ranked = [...rows].sort((a, b) => b.suspicionScore - a.suspicionScore);
  saveJson(resolve(outdir, 'results.json'), {
    status: 'completed', targets: rows, rankedSegments: ranked,
    suspectedSegments: ranked.filter((row) => row.suspectedIssue),
  });
  console.log(JSON.stringify({ verify_claim: ranked.filter((r) => r.suspectedIssue).length,
    not_prioritized: ranked.filter((r) => !r.suspectedIssue).length }));
  console.log(`Total API round-trip time: ${manifest.apiSeconds.toFixed(2)}s`);
  console.log('Screening only: all factual truth statuses remain not_assessed.');
  return outdir;
}

if (require.main === module) {
  Promise.resolve().then(() => run(readOptions())).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
