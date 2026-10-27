import { parseHTML } from 'linkedom'
import type { FetchLike } from '../llm/types.js'
import type { ProviderOptions, SearchHit, SearchProvider } from './types.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * DuckDuckGo lite：无 key 兜底。
 * ★ 它是 HTML 抓取，结构随时可能变；没有 result-link 时返回空数组，由上层提示降级。
 */
export function createDuckDuckGoSearch(opts: ProviderOptions = {}): SearchProvider {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'duckduckgo',
    key: 'duckduckgo',
    async search(query, maxResults = 5) {
      const res = await fetchImpl(
        `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
        {
          headers: { 'user-agent': UA, accept: 'text/html' },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        },
      )
      if (!res.ok) throw new Error(`duckduckgo ${res.status}`)

      const { document } = parseHTML(await res.text())
      const hits: SearchHit[] = []
      for (const row of [...document.querySelectorAll('tr')]) {
        const a = row.querySelector('a.result-link')
        if (a === null) continue
        const href = a.getAttribute('href') ?? ''
        if (href.length === 0) continue

        // ★ snippet 常在下一行，按行配对而不是按全局下标，避免缺一条就整体错位
        const cell =
          row.querySelector('td.result-snippet') ??
          row.nextElementSibling?.querySelector('td.result-snippet')
        hits.push({
          title: (a.textContent ?? '').trim() || href,
          url: href,
          snippet: (cell?.textContent ?? '').trim(),
          provider: 'duckduckgo',
        })
        if (hits.length >= maxResults) break
      }
      return hits
    },
  }
}
