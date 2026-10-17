/**
 * Turns a recorded evidence run (`process/tavily.ts` output under `results/<videoId>/evidence-*`)
 * into source URLs per screening target, for the mock fact-check function.
 */

/** The fields of `evidence.json` this uses. */
export interface EvidenceRun {
  readonly videoId: string;
  /** One Tavily search each; `id` names the `<id>/tavily-response.json` folder. */
  readonly groups: readonly { readonly id: string; readonly targetIds: readonly string[] }[];
  /** Jev's assessment of the search results, when it ran. */
  readonly assessments: readonly { readonly targetId: string; readonly citations: readonly { readonly url: string }[] }[];
}

export interface TavilyResponse {
  readonly results: readonly { readonly url: string; readonly score: number }[];
}

/** Target ID → source URLs, best first. */
export type EvidenceSources = Readonly<Record<string, readonly string[]>>;

const isHttpUrl = (url: string) => /^https?:\/\//.test(url);

const unique = (urls: readonly string[]) => [...new Set(urls.filter(isHttpUrl))];

/**
 * Jev's citations when it cited anything; otherwise the pages Tavily found for the target's
 * search, by Tavily score. The fallback pages are search results Jev did not confirm.
 */
export function buildEvidenceSources(evidence: EvidenceRun, tavily: Readonly<Record<string, TavilyResponse>>): EvidenceSources {
  const cited = new Map(evidence.assessments.map((a) => [a.targetId, unique(a.citations.map((c) => c.url))]));
  const entries = evidence.groups.flatMap((group) => {
    const searched = unique([...(tavily[group.id]?.results ?? [])].sort((a, b) => b.score - a.score).map((r) => r.url));
    return group.targetIds.map((targetId) => {
      const citations = cited.get(targetId) ?? [];
      return [targetId, citations.length > 0 ? citations : searched] as const;
    });
  });
  return Object.fromEntries(entries.filter(([, urls]) => urls.length > 0));
}
