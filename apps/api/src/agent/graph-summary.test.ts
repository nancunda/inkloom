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
    edges: [
      { id: 'e1', from: 'c1', predicate: 'belongsTo', to: 'n1', virtual: true },
      { id: 'e2', from: 'c1', predicate: 'ally', to: 'n1', virtual: false, tombstone: true },
    ],
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

  it('★ 包含节点/边/类计数、每类实例数、error 问题与已批准资料卡', async () => {
    const text = await renderGraphSummary()
    expect(text).toContain('2 节点')
    // tombstone 行不算边：与 /ontology/graph 同口径
    expect(text).toContain('1 边')
    expect(text).toContain('2 类')
    expect(text).toContain('各类实例（含子类）')
    expect(text).toContain('宗门 1')
    expect(text).toContain('error 1')
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

  it('★ 资料卡查询失败只降级资料卡，不否掉图谱', async () => {
    h.lore.mockRejectedValue(new Error('db down'))
    const text = await renderGraphSummary()
    expect(text).toContain('2 节点')
    expect(text).toContain('暂不可用')
    expect(text).not.toContain('图谱概况不可用')
  })

  it('error 只列前 3 条', async () => {
    h.graph.mockResolvedValue({
      ...graph,
      snapshot: {
        ...graph.snapshot,
        issues: [1, 2, 3, 4].map((i) => ({
          severity: 'error',
          code: 'EDGE_ENDPOINT_MISSING',
          subject: `ed-${i}`,
          message: `错误${i}`,
        })),
      },
    })
    const text = await renderGraphSummary()
    expect(text).toContain('错误3')
    expect(text).not.toContain('错误4')
  })

  it('总长压到 800 字以内，并在截断处留省略号', async () => {
    h.lore.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `lr-${i}`,
        title: '很长的资料卡标题'.repeat(10),
        url: 'https://a',
        snippet: '',
        content: null,
        provider: 'tavily',
        approved: true,
      })),
    )
    h.graph.mockResolvedValue({
      ...graph,
      snapshot: {
        ...graph.snapshot,
        classes: [
          ...graph.snapshot.classes,
          ...Array.from({ length: 18 }, (_, i) => ({
            id: `cls-extra${i}`,
            name: '很长的类名'.repeat(8),
            kind: 'concept',
          })),
        ],
        issues: [1, 2, 3].map((i) => ({
          severity: 'error',
          code: 'EDGE_ENDPOINT_MISSING',
          subject: `ed-${i}`,
          message: '长'.repeat(200),
        })),
      },
    })
    const text = await renderGraphSummary()
    expect(text.length).toBeLessThanOrEqual(800)
    expect(text.endsWith('…')).toBe(true)
  })
})
