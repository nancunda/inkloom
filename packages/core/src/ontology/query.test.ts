import type { ClassesFile } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'
import { explainFact, findPath, matchPattern } from './query.js'

const classesFile: ClassesFile = {
  version: 1,
  classes: [
    {
      id: 'cls-character',
      name: '人物',
      parentId: null,
      kind: 'character',
      properties: [],
      rules: [],
    },
    { id: 'cls-sect', name: '宗门', parentId: null, kind: 'group', properties: [], rules: [] },
    {
      id: 'cls-sword',
      name: '剑修',
      parentId: 'cls-character',
      kind: 'character',
      properties: [],
      rules: [],
    },
  ],
  predicates: [
    {
      id: 'instanceOf',
      label: '属于类',
      domain: 'any',
      range: 'class',
      directed: true,
      transitive: false,
    },
    {
      id: 'belongsTo',
      label: '隶属于',
      domain: 'any',
      range: 'any',
      directed: true,
      transitive: false,
    },
    { id: 'ally', label: '同盟', domain: 'any', range: 'any', directed: true, transitive: true },
  ],
}

const node = (id: string, name: string) =>
  ({
    id,
    type: 'concept' as const,
    name,
    attrs: {},
    createdAt: '2026-10-27T00:00:00.000Z',
  }) as never

function snap() {
  const src: GraphSource = {
    characters: [
      { id: 'c1', projectId: 'p', name: '林岚', role: 'protagonist', stateStale: false } as never,
      { id: 'c2', projectId: 'p', name: '玄真', role: 'supporting', stateStale: false } as never,
    ],
    relations: [
      {
        id: 'r1',
        projectId: 'p',
        fromId: 'c1',
        toId: 'c2',
        kind: 'master',
        strength: 3,
      } as never,
    ],
    locations: [],
    routes: [],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [node('n1', '青云宗'), node('n2', '藏剑山庄'), node('n3', '落霞谷')],
    edges: [
      // n1 显式属于宗门：验证 classId 查询走类闭包，而不是只看默认类型映射
      {
        id: 'ed-0',
        from: 'n1',
        predicate: 'instanceOf',
        to: 'cls-sect',
        source: { kind: 'author' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-1',
        from: 'c1',
        predicate: 'belongsTo',
        to: 'n1',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-2',
        from: 'c2',
        predicate: 'belongsTo',
        to: 'n1',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-3',
        from: 'n1',
        predicate: 'ally',
        to: 'n2',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-4',
        from: 'n2',
        predicate: 'ally',
        to: 'n3',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
    ],
    classesFile,
    builtFrom: { files: [], mtimeMax: 0 },
  }
  const g = buildGraph(src)
  // 给 n1 一个属性用于 attr 过滤
  const n1 = g.nodes.get('n1')
  if (n1 !== undefined) n1.attrs = { ...n1.attrs, tier: '一流' }
  return g
}

describe('matchPattern', () => {
  it('节点条件：类闭包 + 属性相等', () => {
    const s = snap()
    const byClass = matchPattern(s, { classId: 'cls-character' })
    expect(byClass.nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2'])

    const byAttr = matchPattern(s, { classId: 'cls-sect', attr: { tier: '一流' } })
    expect(byAttr.nodes.map((n) => n.id)).toEqual(['n1'])
  })

  it('★ 边条件：返回匹配边与两端节点，limit 截断边', () => {
    const s = snap()
    const r = matchPattern(s, { predicate: 'belongsTo', limit: 1 })
    expect(r.edges).toHaveLength(1)
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['c1', 'n1'])

    const from = matchPattern(s, { from: 'c2', predicate: 'belongsTo' })
    expect(from.edges.map((e) => e.id)).toEqual(['ed-2'])
    expect(from.nodes.map((n) => n.id).sort()).toEqual(['c2', 'n1'])
  })

  it('没有边条件时返回节点间的诱导边', () => {
    const s = snap()
    const r = matchPattern(s, { classId: 'cls-sect' })
    expect(r.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(r.edges).toEqual([])
  })

  it('retracted / tombstone 边不参与', () => {
    const s = snap()
    const e = s.edges.find((x) => x.id === 'ed-1')
    if (e !== undefined) e.retracted = true
    const r = matchPattern(s, { predicate: 'belongsTo' })
    expect(r.edges.map((x) => x.id)).not.toContain('ed-1')
  })
})

describe('findPath', () => {
  it('★ 找到最短路径并给出边序列', () => {
    const r = findPath(snap(), 'c1', 'n2')
    expect(r.found).toBe(true)
    expect(r.nodes.map((n) => n.id)).toEqual(['c1', 'n1', 'n2'])
    expect(r.edges.map((e) => e.id)).toEqual(['ed-1', 'ed-3'])
  })

  it('同长度时取字典序稳定结果', () => {
    const first = findPath(snap(), 'c1', 'n2')
    const second = findPath(snap(), 'c1', 'n2')
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id))
  })

  it('maxDepth 限制 + 找不到返回 found=false', () => {
    expect(findPath(snap(), 'c1', 'n2', 1).found).toBe(false)
    expect(findPath(snap(), 'nope', 'n2').found).toBe(false)
  })
})

describe('explainFact', () => {
  it('直接边 / 多跳 / 不存在', () => {
    // edges.jsonl 里的边是 virtual:false；virtual 只属于关系/路线等投影边
    const direct = explainFact(snap(), 'c1', 'belongsTo', 'n1')
    expect(direct).toMatchObject({ found: true, direct: true, virtual: false })
    expect(direct.reason).toContain('直接')

    // ally 是传递谓词：n1—ally→n2—ally→n3 才算 2 跳，混谓词不算
    const multi = explainFact(snap(), 'n1', 'ally', 'n3')
    expect(multi.found).toBe(true)
    expect(multi.direct).toBe(false)
    expect(multi.reason).toContain('2 跳')

    const missing = explainFact(snap(), 'c1', 'ally', 'nope')
    expect(missing.found).toBe(false)
    expect(missing.reason).toContain('没有')
  })

  it('instanceOf 走类闭包（子类实例也算）', () => {
    const r = explainFact(snap(), 'c1', 'instanceOf', 'cls-character')
    expect(r.found).toBe(true)
    expect(r.reason).toContain('子类')
  })
})
