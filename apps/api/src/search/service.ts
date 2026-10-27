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

export interface SearchServiceOptions {
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
  now?: () => number
  /** 兜底超时：与 fetch 实现无关，默认 8s */
  timeoutMs?: number
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未返回`)), ms)
  })
  try {
    return await Promise.race([p, guarded])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createSearchService(opts: SearchServiceOptions = {}): SearchService {
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => Date.now())
  const timeoutMs = opts.timeoutMs ?? 8000
  const providers = buildProviders(env, opts.fetchImpl)

  function isOpen(key: string): boolean {
    const b = breakers.get(key)
    return b !== undefined && b.until > now()
  }

  function fail(key: string): void {
    const b = breakers.get(key) ?? { count: 0, until: 0 }
    b.count += 1
    if (b.count >= MAX_FAILURES) {
      b.until = now() + OPEN_MS
      b.count = 0
    }
    breakers.set(key, b)
  }

  return {
    available: () => providers.map((p) => p.id),

    async search(query, maxResults = 5) {
      const warnings: string[] = []
      for (const provider of providers) {
        if (isOpen(provider.key)) {
          // ★ warnings 会原样回给浏览器：只说类型，不拼熔断键（键里含 SearXNG 的内网地址）
          warnings.push(`${provider.id}：熔断中，跳过`)
          continue
        }
        try {
          const hits = await withTimeout(provider.search(query, maxResults), timeoutMs, provider.id)
          breakers.delete(provider.key)
          return {
            hits,
            provider: provider.id,
            // spec 口径：非 Tavily 都算降级（零 key 时也会提示用兜底源）
            degraded: provider.id !== 'tavily',
            warnings,
          }
        } catch (e) {
          fail(provider.key)
          const msg = e instanceof Error ? e.message : String(e)
          warnings.push(`${provider.id}：${msg.slice(0, 120)}`)
        }
      }
      return { hits: [], provider: null, degraded: true, warnings }
    },
  }
}
