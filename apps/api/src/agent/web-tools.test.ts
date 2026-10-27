import { describe, expect, it, vi } from 'vitest'

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
  it('web_search 落卡并在文本里带资料卡 id', async () => {
    h.search.mockResolvedValue({
      hits: [{ title: 'T', url: 'https://a.example', snippet: 'S', provider: 'duckduckgo' }],
      provider: 'duckduckgo',
      degraded: true,
      warnings: [],
    })
    h.saveHits.mockResolvedValue([{ id: 'lr-abcdef12', title: 'T', url: 'https://a.example' }])

    const res = await tool('web_search').execute('1', { query: '剑冢' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('lr-abcdef12')
    expect(textOf(res)).toContain('duckduckgo')
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
  })

  it('★ read_lore 读不到时 isError', async () => {
    h.getLore.mockResolvedValue(null)
    const res = await tool('read_lore').execute('3', { id: 'lr-nope' })
    expect(res.isError).toBe(true)
  })
})
