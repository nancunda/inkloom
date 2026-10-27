import type { FetchLike } from '../llm/types.js'
import type { ProviderOptions, SearchHit, SearchProvider } from './types.js'

interface SearxngResult {
  title?: string
  url?: string
  content?: string
  publishedDate?: string
}

export function createSearxngSearch(baseUrl: string, opts: ProviderOptions = {}): SearchProvider {
  const base = baseUrl.replace(/\/+$/, '')
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'searxng',
    key: `searxng:${base}`,
    async search(query, maxResults = 5) {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN&safesearch=1`
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'inkloom/0.0.1' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      })
      if (!res.ok) throw new Error(`searxng ${res.status}`)

      const body = (await res.json()) as { results?: SearxngResult[] }
      return (body.results ?? [])
        .filter(
          (r): r is SearxngResult & { url: string } =>
            typeof r.url === 'string' && r.url.length > 0,
        )
        .slice(0, maxResults)
        .map(
          (r): SearchHit => ({
            title: r.title ?? r.url,
            url: r.url,
            snippet: r.content ?? '',
            ...(r.publishedDate === undefined ? {} : { publishedAt: r.publishedDate }),
            provider: 'searxng',
          }),
        )
    },
  }
}
