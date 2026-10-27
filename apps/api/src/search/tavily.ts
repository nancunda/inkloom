import type { FetchLike } from '../llm/types.js'
import type { ProviderOptions, SearchHit, SearchProvider } from './types.js'

export interface TavilySearchOptions extends ProviderOptions {
  apiKey: string
  baseUrl?: string
}

/**
 * Tavily 联网搜索。
 *
 * ★ 按需触发，不自动跑：写第 N 章时每次搜索都要花钱、也会稀释上下文。
 *   由用户在界面上点「查资料」或 CLI 显式调用（spec §10 的联网搜索）。
 * ★ 只返回标题/链接/摘要，不注入任何正文：要不要用、怎么用由人决定。
 */
export function createTavilySearch(opts: TavilySearchOptions): SearchProvider {
  const base = (opts.baseUrl ?? 'https://api.tavily.com').replace(/\/+$/, '')
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'tavily',
    async search(query, maxResults = 5) {
      const res = await fetchImpl(`${base}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: opts.apiKey, query, max_results: maxResults }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      })
      if (!res.ok) throw new Error(`tavily ${res.status}: ${await res.text()}`)

      const body = (await res.json()) as {
        results?: { title?: string; url?: string; content?: string }[]
      }
      return (body.results ?? [])
        .filter((r) => typeof r.url === 'string')
        .map(
          (r): SearchHit => ({
            title: r.title ?? r.url ?? '',
            url: r.url ?? '',
            snippet: r.content ?? '',
            provider: 'tavily',
          }),
        )
    },
  }
}
