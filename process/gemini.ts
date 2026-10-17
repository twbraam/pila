export interface Source {
  title: string;
  uri: string;
}

export interface Grounding {
  groundingChunks?: { web?: { uri?: string; title?: string } }[];
  groundingSupports?: {
    segment?: { partIndex?: number; startIndex?: number; endIndex?: number; text?: string };
    groundingChunkIndices?: number[];
  }[];
}

export interface Candidate {
  content: { parts: { text?: string; thought?: boolean }[] };
  groundingMetadata?: Grounding;
  finishReason?: string;
}

export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export const textOf = (candidate: Candidate) => candidate.content.parts
  .filter(part => !part.thought).map(part => part.text ?? '').join('');

export async function generate(
  body: object,
  apiKey: string,
  stage: string,
  options: { model: string; signal: AbortSignal; fetch: typeof fetch },
): Promise<{ cand: Candidate; ms: number }> {
  options.signal.throwIfAborted();
  const started = performance.now();
  const response = await options.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: 'error',
    },
  );
  // Provider bodies can contain submitted transcript text or credentials.
  if (!response.ok) throw new Error(`Gemini API returned HTTP ${response.status} during ${stage}.`);
  const data = await response.json() as { candidates?: Candidate[] } | null;
  options.signal.throwIfAborted();
  const cand = data?.candidates?.[0];
  if (!cand || !Array.isArray(cand.content?.parts) || cand.content.parts.some(part =>
    !part || typeof part !== 'object' || (part.text !== undefined && typeof part.text !== 'string'))) {
    throw new Error(`Gemini returned an invalid response during ${stage}.`);
  }
  if (cand.finishReason !== undefined && cand.finishReason !== 'STOP') {
    throw new Error(`Gemini did not complete ${stage} (${cand.finishReason}).`);
  }
  if (!textOf(cand).trim()) throw new Error(`Gemini returned no text during ${stage}.`);
  return { cand, ms: performance.now() - started };
}
