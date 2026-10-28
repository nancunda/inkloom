import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  graph: vi.fn(),
  lore: vi.fn(),
}))

vi.mock('../services/ontology-service.js', () => ({ getGraphData: h.graph }))
vi.mock('../services/lore-service.js', () => ({ listLore: h.lore }))
vi.mock('../services/context.js', () => ({
  getContext: () => ({ root: 'C:/book', project: { id: 'p1' }, db: {} }),
}))

import { renderGraphSummary } from './graph-summary.js'

const graph = {
  snapshot: {
    nodes: new Map([
      ['c1', { id: 'c1', type: 'character', name: '林岚', attrs: {}, virtual: true }],
      ['n1', { id: 'n1', type: 'group', name: '青云宗', attrs: {}, virtual: false }],
    ]),
    edges: [{ id: 'e1', from: 'c1', predicate: 'belongsTo', to: 'n1', virtual: true }],
    classOf: new Map([
      ['c1', ['cls-character']],
      ['n1', ['cls-group', 'cls-sect']],
    ]),
    subclasses: new Map(),
    classes: [
      { id: 'cls-character', name: '人物', kind: 'character' },
      { id: 'cls-sect', name: '宗门', kind: 'group' },
    ],
    predicates: [],
    issues: [
      {
        severity: 'error',
        code: 'EDGE_ENDPOINT_MISSING',
        subject: 'ed-x',
        message: '边端点不存在',
      },
      { severity: 'warning', code: 'DUP_NODE', subject: 'c1', message: '重复节点' },
    ],
    builtFrom: { files: [], mtimeMax: 0 },
  },
  warnings: [],
  signature: 'sig',
}

describe('renderGraphSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.graph.mockResolvedValue(graph)
    h.lore.mockResolvedValue([
      {
        id: 'lr-aaa',
        title: '剑冢考据',
        url: 'https://a',
        snippet: '',
        content: null,
        provider: 'tavily',
        approved: true,
      },
    ])
  })

  it('★ 包含节点/边/类计数、error 问题与已批准资料卡', async () => {
    const text = await renderGraphSummary()
    expect(text).toContain('2 节点')
    expect(text).toContain('1 边')
    expect(text).toContain('EDGE_ENDPOINT_MISSING')
    expect(text).not.toContain('DUP_NODE')
    expect(text).toContain('lr-aaa')
    expect(text).toContain('剑冢考据')
  })

  it('★ 图谱不可用时不抛错', async () => {
    h.graph.mockRejectedValue(new Error('尚未打开任何书'))
    const text = await renderGraphSummary()
    expect(text).toContain('图谱概况不可用')
  })

  it('总长压到 800 字以内', async () => {
    h.lore.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `lr-${i}`,
        title: '很长的资料卡标题'.repeat(20),
        url: 'https://a',
        snippet: '',
        content: null,
        provider: 'tavily',
        approved: true,
      })),
    )
    const text = await renderGraphSummary()
    expect(text.length).toBeLessThanOrEqual(800)
  })
})
