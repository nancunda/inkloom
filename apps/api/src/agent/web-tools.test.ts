import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  search: vi.fn(),
  saveHits: vi.fn(),
  savePage: vi.fn(),
  getLore: vi.fn(),
  fetchReadable: vi.fn(),
}))

vi.mock('../search/service.js', () => ({
  createSearchService: () => ({ search: h.search, available: () => ['duckduckgo'] }),
}))
vi.mock('../services/lore-service.js', () => ({
  saveSearchHits: h.saveHits,
  savePage: h.savePage,
  getLoreForRun: h.getLore,
}))
vi.mock('../search/extract.js', () => ({ fetchReadable: h.fetchReadable }))
vi.mock('../services/context.js', () => ({
  getContext: () => ({ root: 'C:/book', project: { id: 'p1' }, db: {} }),
}))

import { createAgentTools } from './tools.js'

/** 只取文本内容：content 是 Text|Image 联合，测试里只看文字 */
function textOf(res: { content: { type: string }[] }): string {
  const first = res.content[0] as { type: string; text?: string } | undefined
  return first?.text ?? ''
}

function tool(name: string) {
  const deps = {
    apiKey: 'k',
    imageApiKey: null,
    model: 'm',
    budget: { steps: 0, maxSteps: 80, chapterCalls: 0, portraitCalls: 0 },
    plan: { getPlanId: () => null, setPlanId: () => undefined, notify: () => undefined },
    onGate: () => undefined,
    getRunId: () => 'ar_1',
  }
  const found = createAgentTools(deps).find((t) => t.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found
}

describe('web tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('web_search 落卡并在文本里带摘要与资料卡 id', async () => {
    h.search.mockResolvedValue({
      hits: [{ title: 'T', url: 'https://a.example', snippet: 'S', provider: 'duckduckgo' }],
      provider: 'duckduckgo',
      degraded: true,
      warnings: [],
    })
    h.saveHits.mockResolvedValue([
      { id: 'lr-abcdef12', title: 'T', url: 'https://a.example', snippet: 'S' },
    ])

    const res = await tool('web_search').execute('1', { query: '剑冢' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('lr-abcdef12')
    expect(textOf(res)).toContain('duckduckgo')
    expect(textOf(res)).toContain(' — S')
    // ★ L3 的「本 run 可读」全靠这两个参数：写反了会让跨会话卡变成本 run 可读
    expect(h.saveHits).toHaveBeenCalledWith(expect.anything(), 'p1', 'ar_1', '剑冢', [
      expect.objectContaining({ url: 'https://a.example' }),
    ])
  })

  it('★ web_search 无结果时 isError 并带上警告', async () => {
    h.search.mockResolvedValue({
      hits: [],
      provider: null,
      degraded: true,
      warnings: ['duckduckgo：超时'],
    })
    const res = await tool('web_search').execute('2', { query: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('超时')
    expect(h.saveHits).not.toHaveBeenCalled()
  })

  it('web_search 搜索抛错时 isError，不把异常扔给框架', async () => {
    h.search.mockRejectedValue(new Error('全部 provider 不可用'))
    const res = await tool('web_search').execute('2b', { query: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('全部 provider 不可用')
  })

  it('★ 落卡失败时仍返回搜索结果，只是没有卡 id', async () => {
    h.search.mockResolvedValue({
      hits: [{ title: 'T', url: 'https://a.example', snippet: 'S', provider: 'tavily' }],
      provider: 'tavily',
      degraded: false,
      warnings: [],
    })
    h.saveHits.mockRejectedValue(new Error('db locked'))
    const res = await tool('web_search').execute('2c', { query: 'x' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('https://a.example')
    expect(textOf(res)).toContain('落卡失败')
  })

  it('read_url 把正文落卡并返回标题', async () => {
    h.fetchReadable.mockResolvedValue({
      title: '页面',
      url: 'https://b.example',
      text: '正文',
      extracted: true,
    })
    h.savePage.mockResolvedValue({ id: 'lr-11112222' })

    const res = await tool('read_url').execute('2', { url: 'https://b.example' })
    expect(textOf(res)).toContain('页面')
    expect(textOf(res)).toContain('lr-11112222')
    expect(h.savePage).toHaveBeenCalledWith(expect.anything(), 'p1', 'ar_1', expect.anything())
  })

  it('★ read_url 落卡失败时仍返回正文', async () => {
    h.fetchReadable.mockResolvedValue({
      title: '页面',
      url: 'https://b.example',
      text: '正文正文',
      extracted: true,
    })
    h.savePage.mockRejectedValue(new Error('db locked'))
    const res = await tool('read_url').execute('2a', { url: 'https://b.example' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('正文正文')
    expect(textOf(res)).toContain('落卡失败')
  })

  it('★ read_url 缺协议时给中文提示，不发请求', async () => {
    const res = await tool('read_url').execute('2b', { url: 'example.com/a?x=1' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('http://')
    expect(h.fetchReadable).not.toHaveBeenCalled()
  })

  it('★ read_lore 读不到时 isError', async () => {
    h.getLore.mockResolvedValue(null)
    const res = await tool('read_lore').execute('3', { id: 'lr-nope' })
    expect(res.isError).toBe(true)
  })

  it('read_lore 只有摘要时明确提示去 read_url', async () => {
    h.getLore.mockResolvedValue({
      id: 'lr-search1',
      title: 'T',
      url: 'https://a.example',
      snippet: '摘要',
      content: null,
      provider: 'duckduckgo',
    })
    const res = await tool('read_lore').execute('4', { id: 'lr-search1' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('摘要')
    expect(textOf(res)).toContain('read_url')
  })
})
