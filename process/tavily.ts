import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { getEncoding } from 'js-tiktoken';
import { assertTranscript, type Transcript } from '../shared/transcript';
import { callJev, loadApiKey, type JevRequest, type SegmentResult } from './jev_call';
import { ROOT, object, saveJson, type Language } from './preprocess';

type Candidate = Pick<SegmentResult, 'videoId' | 'sentenceId' | 'text' | 'start' | 'end' | 'screeningType' | 'suspicionScore'>
  & Partial<Pick<SegmentResult, 'targetId' | 'language'>>;
interface Policy {
  maxSearches: number; maxCandidates: number; maxClaimsPerGroup: number;
  minimumTopicOverlap: number; maxResults: number; cacheHours: number;
  excerptCharacters: number; maxJevRequestTokens: number;
  minimumRelationProbability: number; minimumSourceQualityProbability: number;
  sources: Record<string, 'primary' | 'secondary'>;
}
interface Group { id: string; query: string; claims: Candidate[]; priority: number }
export interface EvidenceSource {
  id: string; url: string; title: string; publisher: string; tier: 'primary' | 'secondary';
  excerpt: string; excerptTruncated: boolean; publicationDateEstimate: string | null; retrievedAt: string;
}
interface EvidenceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
type Relation = 'contradicts' | 'supports' | 'qualifies' | 'insufficient';
type Quality = 'direct_evidence' | 'secondary_summary' | 'unusable';
export interface EvidenceCitation extends EvidenceSource {
  relation: Relation; quality: Quality; relationProbability: number; sourceQualityProbability: number;
}
export interface EvidenceAssessment {
  videoId: string; sentenceId: string; targetId: string; text: string; start: number; end: number;
  screeningScore: number;
  evidenceStatus: 'contradicted' | 'supported' | 'conflicting' | 'needs_context' | 'needs_review' | 'insufficient_evidence';
  citations: EvidenceCitation[];
}
interface Pending { targetId: string; reason: string }
export interface EvidenceOptions {
  maxSearches?: number;
  queryOverrides?: Record<string, string>;
  outdir?: string;
}
export interface EvidenceReport {
  videoId: string; directory: string; searchCalls: number; cacheHits: number; jevCalls: number;
  groups: { id: string; query: string; targetIds: string[]; cacheHit: boolean }[];
  assessments: EvidenceAssessment[];
  pending: Pending[];
}

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
function policy(): Policy { return readJson(resolve(ROOT, 'prompts/evidence-policy.json')) as Policy; }
function id(claim: Candidate): string { return claim.targetId ?? claim.sentenceId; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const STOP = new Set('a an and are as at be been but by for from has have how i in is it its more most not no of on or our so than that the their them there these they this to was we were what when which who will with would you your all any none only very just can could do does don doesn isn aren won did say says said yes assert whatsoever between quite one two group groups actually really now ever never 我們 他們 你們 這個 那個 一個 什麼 怎麼 已經 所以 因為 但是 沒有 不是'.split(' '));
function terms(text: string): Set<string> {
  const segmenter = new Intl.Segmenter('zh-TW', { granularity: 'word' });
  return new Set([...segmenter.segment(text.normalize('NFKC').toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((word) => !STOP.has(word) && (/\p{Script=Han}/u.test(word) || word.length >= 3)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared < 2 ? 0 : shared / Math.max(1, Math.min(a.size, b.size));
}
function queryFor(claims: Candidate[]): string {
  const frequency = new Map<string, number>();
  for (const claim of claims) for (const word of terms(claim.text)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const keywords = [...frequency].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word]) => word);
  // A neutral topic query, not a request to prove a predetermined falsehood.
  return `${keywords.length ? keywords.join(' ') : claims[0]!.text.replace(/\s+/g, ' ')} evidence`.slice(0, 400);
}

/** Pure planning: no Tavily or Jev calls. Groups share research, never verdicts. */
export function planEvidenceChecks(transcript: Transcript, screened: readonly Candidate[]) {
  assertTranscript(transcript);
  const p = policy();
  const sourceSentences = new Map(transcript.sentences.map((s) => [s.id, s]));
  const eligible = screened.filter((claim) => claim.screeningType === 'score' && claim.suspicionScore > 2)
    .sort((a, b) => b.suspicionScore - a.suspicionScore);
  const seen = new Set<string>();
  for (const claim of eligible) {
    const source = sourceSentences.get(claim.sentenceId);
    if (claim.videoId !== transcript.videoId || !source || !Number.isFinite(claim.suspicionScore)
      || claim.suspicionScore > 3 || typeof claim.text !== 'string' || !claim.text.trim()
      || !source.text.includes(claim.text) || claim.start !== source.start || claim.end !== source.end) {
      throw new Error('Evidence candidate text, IDs, scores, and times must match the supplied transcript');
    }
    if (seen.has(id(claim))) throw new Error(`Duplicate target: ${id(claim)}`);
    seen.add(id(claim));
  }
  const pending: Pending[] = eligible.slice(p.maxCandidates).map((c) => ({ targetId: id(c), reason: 'candidate_budget' }));
  const groups: Group[] = [];
  for (const claim of eligible.slice(0, p.maxCandidates)) {
    const words = terms(claim.text);
    const match = groups.filter((g) => g.claims.length < p.maxClaimsPerGroup)
      .map((g) => ({ group: g, similarity: overlap(words, terms(g.claims[0]!.text)) }))
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (match && match.similarity >= p.minimumTopicOverlap) match.group.claims.push(claim);
    else groups.push({ id: `g-${hash([transcript.videoId, id(claim)]).slice(0, 12)}`, query: '', claims: [claim], priority: claim.suspicionScore });
  }
  for (const group of groups) group.query = queryFor(group.claims);
  return { groups, pending, eligibleTargets: eligible.length };
}

function tavilyKey(): string {
  const ambient = process.env.TAVILY_API_KEY?.trim();
  if (ambient && !ambient.startsWith('your_')) return ambient;
  const path = resolve(ROOT, '.env');
  const stored = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')).TAVILY_API_KEY?.trim() ?? '' : '';
  return stored.startsWith('your_') ? '' : stored;
}
function trustedSource(value: unknown, index: number, p: Policy, retrievedAt: string): EvidenceSource | undefined {
  const row = object(value, 'Tavily result');
  if (typeof row.url !== 'string' || typeof row.content !== 'string' || !row.content.trim()) return;
  let url: URL;
  try { url = new URL(row.url); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  const publisher = Object.keys(p.sources).sort((a, b) => b.length - a.length)
    .find((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  if (!publisher) return;
  return { id: `E${index + 1}`, url: url.href, title: typeof row.title === 'string' ? row.title : '',
    publisher, tier: p.sources[publisher]!, excerpt: row.content.slice(0, p.excerptCharacters),
    excerptTruncated: row.content.length > p.excerptCharacters, publicationDateEstimate: typeof row.published_date === 'string' ? row.published_date : null, retrievedAt };
}
async function searchTavily(query: string, p: Policy, directory: string) {
  const request = { query, search_depth: 'basic', auto_parameters: false, max_results: p.maxResults,
    chunks_per_source: 3, include_answer: false, include_raw_content: false, include_domains: Object.keys(p.sources) };
  const cacheDir = resolve(ROOT, 'results/.cache/tavily');
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, `${hash(request)}.json`);
  saveJson(resolve(directory, 'tavily-call.json'), request); // Never save authorization headers.
  if (existsSync(cachePath)) {
    const cached = object(readJson(cachePath), 'Search cache');
    if (typeof cached.cachedAt === 'number' && Date.now() - cached.cachedAt < p.cacheHours * 3600_000) {
      const response = object(cached.response, 'Cached response');
      saveJson(resolve(directory, 'tavily-response.json'), response);
      return { response, cacheHit: true, retrievedAt: new Date(cached.cachedAt).toISOString() };
    }
  }
  const key = tavilyKey();
  if (!key) throw new Error('TAVILY_API_KEY missing from environment or root .env');
  let response: Response;
  try {
    response = await fetch('https://api.tavily.com/search', { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Tavily HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)).replaceAll(key, '[REDACTED]'));
  }
  const data = object(await response.json(), 'Tavily response');
  if (!Array.isArray(data.results)) throw new Error('Tavily returned no results array');
  const cachedAt = Date.now();
  saveJson(cachePath, { cachedAt, response: data });
  saveJson(resolve(directory, 'tavily-response.json'), data);
  return { response: data, cacheHit: false, retrievedAt: new Date(cachedAt).toISOString() };
}

function evidencePayload(transcript: Transcript, claims: Candidate[], sources: EvidenceSource[]) {
  const language: Language = claims[0]?.language ?? (/\p{Script=Han}/u.test(claims[0]?.text ?? '') ? 'zh-TW' : 'en');
  const prompt = object(readJson(resolve(ROOT, 'prompts', `evidence.${language}.json`)), 'Evidence prompt');
  const quality = object(prompt.source_quality, 'Source quality prompt') as unknown as EvidenceQuestion;
  const relation = object(prompt.relation, 'Relation prompt') as unknown as EvidenceQuestion;
  const questions: Record<string, unknown> = {};
  for (const source of sources) questions[`quality_${source.id}`] = {
    ...quality, instructions: quality.instructions.replaceAll('{source_id}', source.id),
  };
  claims.forEach((claim, index) => sources.forEach((source) => {
    questions[`claim_${index}_${source.id}`] = { ...relation,
      instructions: relation.instructions.replaceAll('{target_id}', id(claim)).replaceAll('{source_id}', source.id) };
  }));
  const contextIds = new Set<string>();
  for (const claim of claims) {
    const index = transcript.sentences.findIndex((s) => s.id === claim.sentenceId);
    for (const sentence of transcript.sentences.slice(Math.max(0, index - 1), index + 2)) contextIds.add(sentence.id);
  }
  return { model: String(prompt.model), state: { instructions: prompt.instructions,
    claimDate: 'unknown_unless_explicit_in_transcript', retrievedAt: sources[0]?.retrievedAt ?? null,
    claims: claims.map((c) => ({ targetId: id(c), sourceSentenceId: c.sentenceId, text: c.text })),
    transcriptContext: transcript.sentences.filter((s) => contextIds.has(s.id)), sources }, questions } satisfies JevRequest;
}
function choice(answers: Record<string, unknown>, key: string, allowed: readonly string[]): string {
  const answer = object(answers[key], `Answer ${key}`);
  if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !allowed.includes(answer.choice)) {
    throw new Error(`Invalid evidence answer: ${key}`);
  }
  return answer.choice;
}
function probability(answers: Record<string, unknown>, key: string, label: string): number {
  const answer = object(answers[key], key);
  const distribution = answer.probabilities;
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) return 0;
  const value = (distribution as Record<string, unknown>)[label];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}
function assess(claims: Candidate[], sources: EvidenceSource[], response: Record<string, unknown>, p: Policy): EvidenceAssessment[] {
  const answers = object(response.answers, 'Evidence answers');
  const qualities = new Map(sources.map((s) => [s.id, choice(answers, `quality_${s.id}`,
    ['direct_evidence', 'secondary_summary', 'unusable']) as Quality]));
  return claims.map((claim, index) => {
    const citations: EvidenceCitation[] = sources.map((s) => {
      const quality = qualities.get(s.id)!;
      const relation = choice(answers, `claim_${index}_${s.id}`, ['contradicts', 'supports', 'qualifies', 'insufficient']) as Relation;
      return { ...s, quality, relation,
        relationProbability: probability(answers, `claim_${index}_${s.id}`, relation),
        sourceQualityProbability: probability(answers, `quality_${s.id}`, quality) };
    });
    const usable = citations.filter((c) => c.quality !== 'unusable' && c.relation !== 'insufficient');
    const primary = usable.filter((c) => c.tier === 'primary' && c.quality === 'direct_evidence'
      && c.relationProbability >= p.minimumRelationProbability
      && c.sourceQualityProbability >= p.minimumSourceQualityProbability);
    const both = usable.some((c) => c.relation === 'contradicts') && usable.some((c) => c.relation === 'supports');
    const status: EvidenceAssessment['evidenceStatus'] = both ? 'conflicting'
      : usable.some((c) => c.relation === 'qualifies') ? 'needs_context'
      : primary.some((c) => c.relation === 'contradicts') ? 'contradicted'
      : primary.some((c) => c.relation === 'supports') ? 'supported'
      : usable.length ? 'needs_review' : 'insufficient_evidence';
    return { videoId: claim.videoId, sentenceId: claim.sentenceId, targetId: id(claim), text: claim.text,
      start: claim.start, end: claim.end, screeningScore: claim.suspicionScore, evidenceStatus: status,
      citations: citations.filter((c) => c.relation !== 'insufficient' && c.quality !== 'unusable') };
  });
}

/** Application API: bounded Tavily REST searches followed by evidence-only Jev assessments. */
export async function verifySuspicions(transcript: Transcript, screened: readonly Candidate[], options: EvidenceOptions = {}): Promise<EvidenceReport> {
  const p = policy();
  const limit = options.maxSearches ?? p.maxSearches;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('maxSearches must be a nonnegative integer');
  const plan = planEvidenceChecks(transcript, screened);
  const directory = options.outdir ? resolve(options.outdir)
    : resolve(ROOT, 'results', transcript.videoId, `evidence-${new Date().toISOString().replace(/[-:.]/g, '')}`);
  mkdirSync(resolve(directory, '..'), { recursive: true });
  mkdirSync(directory); // No overwrites or silent reuse of partial runs.
  saveJson(resolve(directory, 'plan.json'), plan);
  const report: EvidenceReport = { videoId: transcript.videoId, directory, searchCalls: 0, cacheHits: 0,
    jevCalls: 0, groups: [], assessments: [], pending: [...plan.pending] };
  const selected = plan.groups.slice(0, limit);
  for (const group of plan.groups.slice(limit)) for (const claim of group.claims) {
    report.pending.push({ targetId: id(claim), reason: 'search_budget' });
  }
  const key = selected.length ? loadApiKey() : '';
  if (selected.length && !key) throw new Error('Jev API key missing');
  const encoder = getEncoding('cl100k_base');
  try {
    for (const group of selected) {
      const folder = resolve(directory, group.id);
      mkdirSync(folder);
      const query = options.queryOverrides?.[group.id] ?? group.query;
      if (!query.trim()) throw new Error('Search query must not be empty');
      const found = await searchTavily(query, p, folder);
      if (found.cacheHit) report.cacheHits++; else report.searchCalls++;
      const raw = found.response.results;
      if (!Array.isArray(raw)) throw new Error('Tavily results must be an array');
      const seenUrls = new Set<string>();
      const sources = raw.map((r, index) => trustedSource(r, index, p, found.retrievedAt)).filter((s): s is EvidenceSource => {
        if (!s || seenUrls.has(s.url)) return false;
        seenUrls.add(s.url);
        return true;
      });
      report.groups.push({ id: group.id, query, targetIds: group.claims.map(id), cacheHit: found.cacheHit });
      const verify = async (claims: Candidate[], suffix: string): Promise<void> => {
        const payload = evidencePayload(transcript, claims, sources);
        if (!sources.length) {
          report.assessments.push(...claims.map((c) => ({ videoId: c.videoId, sentenceId: c.sentenceId,
            targetId: id(c), text: c.text, start: c.start, end: c.end, screeningScore: c.suspicionScore,
            evidenceStatus: 'insufficient_evidence' as const, citations: [] })));
          return;
        }
        if (encoder.encode(JSON.stringify(payload), [], []).length > p.maxJevRequestTokens) {
          if (claims.length === 1) {
            report.pending.push({ targetId: id(claims[0]!), reason: 'evidence_context_budget' });
            return;
          }
          const middle = Math.ceil(claims.length / 2);
          await verify(claims.slice(0, middle), `${suffix}a`);
          await verify(claims.slice(middle), `${suffix}b`);
          return;
        }
        saveJson(resolve(folder, `jev-call-${suffix}.json`), payload);
        const response = await callJev(key, payload);
        report.jevCalls++;
        saveJson(resolve(folder, `jev-response-${suffix}.json`), response);
        report.assessments.push(...assess(claims, sources, response, p));
      };
      await verify(group.claims, '0');
      saveJson(resolve(directory, 'evidence.json'), { status: 'partial', ...report });
    }
    saveJson(resolve(directory, 'evidence.json'), { status: 'completed', ...report });
    return report;
  } catch (error) {
    const completed = new Set([...report.assessments.map((a) => a.targetId), ...report.pending.map((p) => p.targetId)]);
    for (const group of selected) for (const claim of group.claims) {
      if (!completed.has(id(claim))) report.pending.push({ targetId: id(claim), reason: 'run_failed' });
    }
    const detail = error instanceof Error ? error.message : String(error);
    const message = key ? detail.replaceAll(key, '[REDACTED]') : detail;
    saveJson(resolve(directory, 'evidence.json'), { status: 'failed', ...report, error: message });
    throw new Error(`Evidence run failed; artifacts: ${directory}. ${message}`);
  }
}
