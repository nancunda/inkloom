import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { createDuckDuckGoSearch } from './duckduckgo.js'
import { createSearxngSearch } from './searxng.js'
import { createTavilySearch } from './tavily.js'

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('searxng', () => {
  it('把 results 归一化成 SearchHit', async () => {
    const fetchImpl: FetchLike = async () =>
      json({
        results: [
          {
            title: '剑冢考据',
            url: 'https://a.example/1',
            content: '摘要一',
            publishedDate: '2026-01-02',
          },
        ],
      })
    const p = createSearxngSearch('https://searx.example', { fetchImpl })
    const hits = await p.search('剑冢', 5)
    expect(p.id).toBe('searxng')
    expect(hits).toEqual([
      {
        title: '剑冢考据',
        url: 'https://a.example/1',
        snippet: '摘要一',
        publishedAt: '2026-01-02',
        provider: 'searxng',
      },
    ])
  })

  it('★ HTTP 失败抛状态码', async () => {
    const fetchImpl: FetchLike = async () => html('forbidden', 403)
    await expect(
      createSearxngSearch('https://searx.example', { fetchImpl }).search('q', 3),
    ).rejects.toThrow('searxng 403')
  })

  it('★ 丢掉没有 url 的脏结果', async () => {
    const fetchImpl: FetchLike = async () =>
      json({ results: [{ title: '无链接' }, { url: 'https://a.example/2' }] })
    const hits = await createSearxngSearch('https://searx.example', { fetchImpl }).search('q', 3)
    expect(hits.map((h) => h.url)).toEqual(['https://a.example/2'])
  })
})

describe('duckduckgo lite', () => {
  it('解析 result-link 与 result-snippet', async () => {
    const fetchImpl: FetchLike = async () =>
      html(`
        <table>
          <tr><td><a class="result-link" href="https://b.example/x">剑冢是什么</a></td></tr>
          <tr><td class="result-snippet">一种埋剑的墓。</td></tr>
        </table>`)
    const hits = await createDuckDuckGoSearch({ fetchImpl }).search('剑冢', 5)
    expect(hits).toEqual([
      {
        title: '剑冢是什么',
        url: 'https://b.example/x',
        snippet: '一种埋剑的墓。',
        provider: 'duckduckgo',
      },
    ])
  })

  it('★ 挑战页（没有 result-link）返回空数组，不抛错', async () => {
    const fetchImpl: FetchLike = async () => html('<html><body>challenge</body></html>')
    await expect(createDuckDuckGoSearch({ fetchImpl }).search('q', 3)).resolves.toEqual([])
  })

  it('★ HTTP 失败抛状态码', async () => {
    const fetchImpl: FetchLike = async () => html('bad', 403)
    await expect(createDuckDuckGoSearch({ fetchImpl }).search('q', 3)).rejects.toThrow(
      'duckduckgo 403',
    )
  })
})

describe('tavily', () => {
  it('返回 snippet 与 provider', async () => {
    const fetchImpl: FetchLike = async () =>
      json({ results: [{ title: 'T', url: 'https://c.example', content: 'C' }] })
    const hits = await createTavilySearch({ apiKey: 'k', fetchImpl }).search('q', 3)
    expect(hits[0]).toMatchObject({
      title: 'T',
      url: 'https://c.example',
      snippet: 'C',
      provider: 'tavily',
    })
  })
})
