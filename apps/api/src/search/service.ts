import type { FetchLike } from '../llm/types.js'
import { createDuckDuckGoSearch } from './duckduckgo.js'
import { createSearxngSearch } from './searxng.js'
import { createTavilySearch } from './tavily.js'
import type { SearchProvider, SearchProviderId, SearchResult } from './types.js'

export interface SearchService {
  search(query: string, maxResults?: number): Promise<SearchResult>
  available(): SearchProviderId[]
}

interface Breaker {
  count: number
  until: number
}

const OPEN_MS = 10 * 60_000
const MAX_FAILURES = 2

/** 进程级熔断表：跨多次工具调用保持；测试用 resetSearchBreakersForTest 清空 */
const breakers = new Map<string, Breaker>()

export function resetSearchBreakersForTest(): void {
  breakers.clear()
}

function buildProviders(env: NodeJS.ProcessEnv, fetchImpl?: FetchLike): SearchProvider[] {
  const out: SearchProvider[] = []
  const tavilyKey = (env['TAVILY_API_KEY'] ?? '').trim()
  if (tavilyKey.length > 0) {
    out.push(
      createTavilySearch({ apiKey: tavilyKey, ...(fetchImpl === undefined ? {} : { fetchImpl }) }),
    )
  }

  const bases = (env['SEARXNG_BASE_URLS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const base of bases) {
    out.push(createSearxngSearch(base, fetchImpl === undefined ? {} : { fetchImpl }))
  }

  out.push(createDuckDuckGoSearch(fetchImpl === undefined ? {} : { fetchImpl }))
  return out
}

export function createSearchService(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => number } = {},
): SearchService {
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => Date.now())
  const providers = buildProviders(env, opts.fetchImpl)

  function isOpen(id: string): boolean {
    const b = breakers.get(id)
    return b !== undefined && b.until > now()
  }

  function fail(id: string): void {
    const b = breakers.get(id) ?? { count: 0, until: 0 }
    b.count += 1
    if (b.count >= MAX_FAILURES) {
      b.until = now() + OPEN_MS
      b.count = 0
    }
    breakers.set(id, b)
  }

  return {
    available: () => providers.map((p) => p.id),

    async search(query, maxResults = 5) {
      const warnings: string[] = []
      for (const provider of providers) {
        if (isOpen(provider.id)) {
          warnings.push(`${provider.id}：熔断中，跳过`)
          continue
        }
        try {
          const hits = await provider.search(query, maxResults)
          breakers.delete(provider.id)
          return {
            hits,
            provider: provider.id,
            degraded: provider.id !== 'tavily',
            warnings,
          }
        } catch (e) {
          fail(provider.id)
          warnings.push(`${provider.id}：${(e as Error).message.slice(0, 120)}`)
        }
      }
      return { hits: [], provider: null, degraded: true, warnings }
    },
  }
}
