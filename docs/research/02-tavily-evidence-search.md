# Evidence search with Tavily

Tavily is a web search API built for AI apps. It returns ranked results with clean text
snippets, so we don't scrape or clean HTML ourselves.

## API

```http
POST https://api.tavily.com/search
Authorization: Bearer tvly-<API_KEY>
Content-Type: application/json
```

Request fields we use:

| Field | Our value | Notes |
| - | - | - |
| `query` | see "Queries" below | |
| `search_depth` | `basic` (1 credit), `advanced` (2 credits) for the video-level search | `advanced` gives better snippets |
| `chunks_per_source` | 3 | Snippets per result (~500 chars each for `basic`, ~800 for `advanced`), joined with `[...]` |
| `max_results` | 5 | Max 20 |
| `include_domains` + `include_domains_mode: "prefer"` | fact-check domain list | `prefer` ranks these first but still searches the rest of the web. The default `restrict` would drop everything else. |
| `topic` | `general` | `news` for recent events |
| `include_answer` | `false` | Tavily's own LLM answer. We don't want a second model's opinion mixed into evidence. |

Response fields we use: `results[]` with `title`, `url`, `content`, `score` (relevance
0-1); `response_time`; `usage.credits`; `request_id` (log it for support).

Errors: 400, 401 (bad key), 422, 429 (rate limit), 432 and 433 (plan or credit limit
reached). Map 432/433 to a clear "Tavily credits used up" error.

## Limits and cost

- Free plan: 1,000 credits/month, no card. Pay-as-you-go: $0.008/credit.
- Rate limit: 100 requests/minute (development key), 1,000 (production key).
- Per 5-minute video with K=5 claims: 6 searches = 6-12 credits. So a free key covers
  roughly 80-160 videos a month.
- **Keyless mode** for quick tests: send `X-Tavily-Access-Mode: keyless` and no key.
  Rate-limited, same response shape. Good for local experiments, not for the demo.

## SDK or plain fetch?

`@tavily/core` (v0.7.14) depends on `axios`, `js-tiktoken`, and `https-proxy-agent`.
The last one is Node-only and the tokenizer is large, so it is a poor fit for a
service worker. We only need one endpoint, so the library calls it with `fetch`
directly (~50 lines with types and error mapping).

## Queries

Tested 2026-10-17 on `ref/transcript.json` (Richard Lindzen, PragerU):

| Query | Result |
| - | - |
| `IPCC 2007 report "The long-term prediction of future climate states is not possible" fact check` (no domain preference) | Top 3 were IPCC report PDFs, showing only cover pages. Useless as evidence. |
| `Richard Lindzen PragerU climate change video claims fact check` + fact-check domains preferred | #1 and #2: Science Feedback's review of this exact video ("several incorrect and misleading claims"). Snippet quotes the claim and says "This is false". |
| Chinese: `林德森 PragerU 气候变化 影片 事实查核` + domains preferred | #1 was still the English Science Feedback review. Results after #3 were off-topic (score 0.03-0.4). |

What we learned:

1. **Do one video-level search** with speaker / channel / title + "fact check". If
   someone already reviewed the video, that review is the best evidence for every claim.
2. **Then one search per claim**: the claim text + "fact check", same domain preference.
3. **Prefer fact-check domains** (`include_domains_mode: "prefer"`).
4. **Drop low-score results** (start at `score` < 0.5). They were off-topic in testing.
5. **De-duplicate**: Science Feedback appeared twice under two domains
   (`science.feedback.org`, `climatefeedback.org`). Group by title.
6. Cap each source at ~1,500 characters and at most 3-5 sources per claim.

## Default domain list (starting point)

- Fact-checkers (English): `science.feedback.org`, `climatefeedback.org`,
  `healthfeedback.org`, `factcheck.org`, `politifact.com`, `snopes.com`, `fullfact.org`,
  `reuters.com`, `apnews.com`, `afp.com`, `skepticalscience.com`
- Fact-checkers (Chinese): `tfc-taiwan.org.tw`, `mygopen.com`, `cofacts.tw`
- Science bodies: `ipcc.ch`, `nasa.gov`, `noaa.gov`, `who.int`

The list is config, not code. The same list sets source trust in the verdict rules
([01](./01-jev-integration.md#combining-the-answers-in-code)).

## Mapping a result to evidence

```ts
{ source: "Science Feedback", url: result.url, text: result.content.slice(0, 1500) }
```

`source` comes from the title suffix (`"... - Science Feedback"`) or the hostname.
