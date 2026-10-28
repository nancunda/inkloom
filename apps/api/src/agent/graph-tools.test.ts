import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { GraphSnapshot } from '@inkloom/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ snapshot: vi.fn() }))

vi.mock('../services/ontology-service.js', () => ({
  getGraphSnapshot: h.snapshot,
}))

import { createGraphTools } from './graph-tools.js'

function tool(name: string): AgentTool {
  const found = createGraphTools().find((t) => t.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found as AgentTool
}

function textOf(res: { content: { type: string }[] }): string {
  const first = res.content[0] as { type: string; text?: string } | undefined
  return first?.text ?? ''
}

const snap = {
  nodes: new Map([
    ['c1', { id: 'c1', type: 'character', name: '林岚', attrs: { tier: '一流' }, virtual: true }],
    ['c2', { id: 'c2', type: 'character', name: '玄真', attrs: {}, virtual: true }],
    ['c3', { id: 'c3', type: 'character', name: '沈砚', attrs: {}, virtual: true }],
  ]),
  edges: [
    {
      id: 'ed-1',
      from: 'c1',
      predicate: 'belongsTo',
      to: 'c2',
      virtual: true,
      source: { kind: 'agent' },
    },
    {
      id: 'ed-2',
      from: 'c2',
      predicate: 'belongsTo',
      to: 'c3',
      virtual: true,
      source: { kind: 'agent' },
    },
  ],
  classOf: new Map([
    ['c1', ['cls-character']],
    ['c2', ['cls-character']],
  ]),
  subclasses: new Map(),
  classes: [
    {
      id: 'cls-character',
      name: '人物',
      parentId: null,
      kind: 'character',
      properties: [],
      rules: [],
    },
  ],
  predicates: [
    {
      id: 'belongsTo',
      label: '隶属',
      domain: 'any',
      range: 'any',
      directed: true,
      transitive: false,
    },
  ],
  issues: [],
  builtFrom: { files: [], mtimeMax: 0 },
} as unknown as GraphSnapshot

describe('graph tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.snapshot.mockResolvedValue(snap)
  })

  it('★ query_graph 返回摘要与 details', async () => {
    const res = await tool('query_graph').execute('1', { predicate: 'belongsTo', from: 'c1' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('1 条边')
    expect(textOf(res)).toContain('林岚')
    expect(textOf(res)).toContain('belongsTo')
    const details = res.details as {
      nodeCount: number
      edgeCount: number
      nodes: { id: string }[]
      edges: { id: string }[]
    }
    expect(details.nodeCount).toBe(2)
    expect(details.edgeCount).toBe(1)
    expect(details.edges.map((e) => e.id)).toEqual(['ed-1'])
  })

  it('★ query_graph 真的透传 classId（不存在的类 → 空）', async () => {
    const res = await tool('query_graph').execute('1d', { classId: 'cls-nonexistent' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('没有匹配')
  })

  it('★ query_graph 真的透传 attr', async () => {
    const res = await tool('query_graph').execute('1e', { attr: { tier: '一流' } })
    expect((res.details as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual(['c1'])
  })

  it('★ query_graph 真的截断 limit', async () => {
    const res = await tool('query_graph').execute('1f', { nodeType: 'character', limit: 1 })
    expect((res.details as { nodeCount: number }).nodeCount).toBe(1)
  })

  it('query_graph 查不到时 isError 并提示放宽', async () => {
    const res = await tool('query_graph').execute('1b', { predicate: 'nope' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('没有匹配')
  })

  it('find_path 找到时给逐跳文本', async () => {
    const res = await tool('find_path').execute('2', { from: 'c1', to: 'c2' })
    expect(textOf(res)).toContain('林岚')
    expect(textOf(res)).toContain('玄真')
    expect(textOf(res)).toContain('隶属')
  })

  it('★ find_path 逐跳按边方向渲染：反向跨越带「反向」标记', async () => {
    const forward = await tool('find_path').execute('2a', { from: 'c1', to: 'c2' })
    expect(textOf(forward)).toContain('1. 林岚 —隶属→ 玄真')

    const back = await tool('find_path').execute('2b', { from: 'c2', to: 'c1' })
    expect(textOf(back)).toContain('1. 林岚 —隶属→ 玄真（反向）')
  })

  it('★ find_path 多跳且反向：逐跳都按边方向渲染', async () => {
    const forward = await tool('find_path').execute('2d', { from: 'c1', to: 'c3' })
    expect(textOf(forward)).toContain('1. 林岚 —隶属→ 玄真')
    expect(textOf(forward)).toContain('2. 玄真 —隶属→ 沈砚')
    expect(textOf(forward)).not.toContain('反向')

    const back = await tool('find_path').execute('2e', { from: 'c3', to: 'c1' })
    expect(textOf(back)).toContain('1. 玄真 —隶属→ 沈砚（反向）')
    expect(textOf(back)).toContain('2. 林岚 —隶属→ 玄真（反向）')
  })

  it('find_path 同一节点：0 跳且 details 形状一致', async () => {
    const res = await tool('find_path').execute('2c', { from: 'c1', to: 'c1' })
    expect(textOf(res)).toContain('同一个节点')
    expect(res.details).toMatchObject({
      found: true,
      hops: 0,
      nodes: [{ id: 'c1' }],
      edges: [],
    })
  })

  it('★ find_path 找不到时 isError，并提示用 query_graph', async () => {
    const res = await tool('find_path').execute('3', { from: 'c1', to: 'nope' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('query_graph')
  })

  it('explain_fact 不存在时 isError', async () => {
    const res = await tool('explain_fact').execute('4', {
      from: 'c1',
      predicate: 'ally',
      to: 'c2',
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('没有找到')
  })

  it('★ explain_fact 命中直接边：文本与 details 一致', async () => {
    const res = await tool('explain_fact').execute('4b', {
      from: 'c1',
      predicate: 'belongsTo',
      to: 'c2',
    })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('直接边')
    expect(res.details).toMatchObject({ direct: true, via: ['c1', 'c2'] })
  })

  it('图谱读不到时工具降级，不抛出', async () => {
    h.snapshot.mockRejectedValue(new Error('尚未打开任何书'))
    const res = await tool('query_graph').execute('5', {})
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('图谱不可用')
  })

  it('工具描述写明只读', () => {
    expect(tool('query_graph').description).toContain('write_element')
  })
})
