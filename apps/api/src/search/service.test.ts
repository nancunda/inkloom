import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { createSearchService, resetSearchBreakersForTest } from './service.js'

beforeEach(() => resetSearchBreakersForTest())

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ddgPage(): Response {
  return new Response('<a class="result-link" href="https://c.example">C</a>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
}

describe('search service', () => {
  it('有 TAVILY key 时优先 Tavily，degraded=false', async () => {
    const fetchImpl: FetchLike = async () =>
      json({ results: [{ title: 'T', url: 'https://a.example', content: 'S' }] })
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchImpl,
    })
    const r = await svc.search('q')
    expect(r.provider).toBe('tavily')
    expect(r.degraded).toBe(false)
    expect(r.hits).toHaveLength(1)
  })

  it('★ Tavily 失败后降级到 SearXNG，并记录 warning', async () => {
    let call = 0
    const fetchImpl: FetchLike = async () => {
      call += 1
      if (call === 1) return json({ detail: 'bad' }, 401)
      return json({ results: [{ title: 'S', url: 'https://b.example', content: 'X' }] })
    }
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k', SEARXNG_BASE_URLS: 'https://searx.example' } as NodeJS.ProcessEnv,
      fetchImpl,
    })
    const r = await svc.search('q')
    expect(r.provider).toBe('searxng')
    expect(r.degraded).toBe(true)
    expect(r.warnings.join(' ')).toContain('tavily')
  })

  it('★ 无 key 时走 DuckDuckGo，degraded=true', async () => {
    const fetchImpl: FetchLike = async () => ddgPage()
    const svc = createSearchService({ env: {} as NodeJS.ProcessEnv, fetchImpl })
    const r = await svc.search('q')
    expect(r.provider).toBe('duckduckgo')
    expect(r.degraded).toBe(true)
  })

  it('★ 连续 2 次失败后熔断 10 分钟，不再请求该 provider', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('api.tavily.com')) return json({ detail: 'down' }, 500)
      return ddgPage()
    }) as unknown as FetchLike
    let now = 0
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchImpl,
      now: () => now,
    })

    await svc.search('a')
    await svc.search('b')
    const before = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    now += 60_000
    await svc.search('c')
    const after = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    // 前两次：tavily + ddg 各一次；第三次 tavily 熔断，只剩 ddg
    expect(before).toBe(4)
    expect(after).toBe(5)
  })

  it('全部失败时返回空结果与每个 provider 的原因', async () => {
    const fetchImpl: FetchLike = async () => json({ detail: 'down' }, 500)
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchImpl,
    })
    const r = await svc.search('q')
    expect(r.hits).toEqual([])
    expect(r.provider).toBeNull()
    expect(r.degraded).toBe(true)
    expect(r.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('★ 一个 SearXNG 实例失败不会挡住后面的健康实例', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      seen.push(String(url))
      if (String(url).startsWith('https://bad')) return json({ detail: 'x' }, 500)
      return json({ results: [{ title: 'S', url: 'https://ok.example', content: 'X' }] })
    }
    const svc = createSearchService({
      env: {
        SEARXNG_BASE_URLS: 'https://bad1.example,https://bad2.example,https://good.example',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    })
    const r = await svc.search('q')
    expect(r.provider).toBe('searxng')
    expect(seen.some((u) => u.startsWith('https://good'))).toBe(true)
  })

  it('★ provider 永不返回时按超时失败并降级', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('api.tavily.com')) return new Promise<Response>(() => undefined)
      return ddgPage()
    }
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchImpl,
      timeoutMs: 20,
    })
    const r = await svc.search('q')
    expect(r.provider).toBe('duckduckgo')
    expect(r.warnings.join(' ')).toContain('未返回')
  })

  it('★ provider 抛字符串也能降级，不会让整条链崩掉', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('api.tavily.com')) return Promise.reject('boom')
      return ddgPage()
    }
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchImpl,
    })
    const r = await svc.search('q')
    expect(r.provider).toBe('duckduckgo')
    expect(r.warnings.join(' ')).toContain('boom')
  })
})
