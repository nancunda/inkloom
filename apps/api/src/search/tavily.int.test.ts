import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { createTavilySearch } from './tavily.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Tavily 搜索', () => {
  it('★ 请求体带 api_key / query / max_results', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return jsonResponse({ results: [{ title: 'T', url: 'https://e.com', content: '摘要' }] })
    }
    const provider = createTavilySearch({ apiKey: 'tvly-test', fetchImpl })
    const hits = await provider.search('剑冢 设定', 3)

    expect(provider.id).toBe('tavily')
    expect(sent['api_key']).toBe('tvly-test')
    expect(sent['query']).toBe('剑冢 设定')
    expect(sent['max_results']).toBe(3)
    expect(hits).toEqual([
      { title: 'T', url: 'https://e.com', snippet: '摘要', provider: 'tavily' },
    ])
  })

  it('默认返回 5 条上限', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return jsonResponse({ results: [] })
    }
    await createTavilySearch({ apiKey: 'k', fetchImpl }).search('q')
    expect(sent['max_results']).toBe(5)
  })

  it('★ 没有 url 的结果被丢弃（点不开的链接没有价值）', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        results: [
          { title: '有效', url: 'https://a.com', content: 'x' },
          { title: '无链接', content: 'y' },
          { url: 'https://b.com' },
        ],
      })
    const hits = await createTavilySearch({ apiKey: 'k', fetchImpl }).search('q')
    expect(hits.map((h) => h.url)).toEqual(['https://a.com', 'https://b.com'])
    // 缺标题时用 url 顶上，不留空标题
    expect(hits[1]?.title).toBe('https://b.com')
  })

  it('★ HTTP 失败原样抛出状态码', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ detail: 'unauthorized' }, 401)
    await expect(createTavilySearch({ apiKey: 'bad', fetchImpl }).search('q')).rejects.toThrow(
      /tavily 401/,
    )
  })

  it('空结果返回空数组，不抛错', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({})
    await expect(createTavilySearch({ apiKey: 'k', fetchImpl }).search('q')).resolves.toEqual([])
  })
})
