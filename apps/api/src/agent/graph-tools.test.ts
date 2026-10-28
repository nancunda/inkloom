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
    ['c1', { id: 'c1', type: 'character', name: '林岚', attrs: {}, virtual: true }],
    ['c2', { id: 'c2', type: 'character', name: '玄真', attrs: {}, virtual: true }],
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

  it('★ query_graph 返回摘要与 JSON', async () => {
    const res = await tool('query_graph').execute('1', { predicate: 'belongsTo' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('1 条边')
    expect(textOf(res)).toContain('林岚')
    expect(textOf(res)).toContain('belongsTo')
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
