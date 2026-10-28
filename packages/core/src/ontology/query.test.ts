import type { Character, CharacterRelation, ClassesFile, OntologyNode } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'
import { explainFact, findPath, matchPattern } from './query.js'
import type { GraphSnapshot } from './types.js'

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
    { id: 'route', label: '路线', domain: 'any', range: 'any', directed: true, transitive: false },
  ],
}

function node(id: string, name: string): OntologyNode {
  return {
    id,
    type: 'concept',
    name,
    aliases: [],
    summary: '',
    attrs: {},
    createdAt: '2026-10-27T00:00:00.000Z',
  }
}

const person = (id: string, name: string): Character =>
  ({
    id,
    projectId: 'p',
    name,
    role: 'supporting',
    stateStale: false,
  }) as unknown as Character

const edge = (
  id: string,
  from: string,
  predicate: string,
  to: string,
  over: { undirected?: boolean } = {},
) => ({
  id,
  from,
  predicate,
  to,
  source: { kind: 'agent' as const },
  createdAt: '2026-10-27T00:00:00.000Z',
  ...over,
})

function snap() {
  const src: GraphSource = {
    characters: [person('c1', '林岚'), person('c2', '玄真')],
    relations: [
      {
        id: 'r1',
        projectId: 'p',
        fromId: 'c1',
        toId: 'c2',
        kind: 'master',
        strength: 3,
      } as unknown as CharacterRelation,
    ],
    locations: [],
    routes: [],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [
      node('n1', '青云宗'),
      node('n2', '藏剑山庄'),
      node('n3', '落霞谷'),
      node('n4', '碧落'),
      node('n5', '寒潭'),
      node('n6', '苍梧'),
      node('n7', '白帝城'),
      node('n8', '幽都'),
      node('cn1', '剑修甲'),
    ],
    edges: [
      // n1 显式属于宗门：验证 classId 查询走类闭包，而不是只看默认类型映射
      edge('ed-0', 'n1', 'instanceOf', 'cls-sect'),
      edge('ed-1', 'c1', 'belongsTo', 'n1'),
      edge('ed-2', 'c2', 'belongsTo', 'n1'),
      edge('ed-3', 'n1', 'ally', 'n2'),
      edge('ed-4', 'n2', 'ally', 'n3'),
      // 与 n1 等长的另一条 2 跳路径：锁住「同长度取字典序」
      edge('ed-5', 'c1', 'ally', 'n4'),
      edge('ed-6', 'n4', 'ally', 'n2'),
      // 4 跳可达 / 5 跳超限
      edge('ed-7', 'n3', 'ally', 'n5'),
      edge('ed-8', 'n5', 'ally', 'n6'),
      edge('ed-9', 'n6', 'ally', 'n7'),
      edge('ed-10', 'n7', 'ally', 'n8'),
      // 双向路线：匹配忽略方向
      edge('ed-11', 'n2', 'route', 'n3', { undirected: true }),
      // 子类实例：父类查询要能带出来
      edge('ed-12', 'cn1', 'instanceOf', 'cls-sword'),
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
    // cn1 的 classOf 含父类：子类实例也要按父类查得出来
    expect(byClass.nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2', 'cn1'])

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

  it('★ 双向路线：from/to 反向也能匹配', () => {
    const s = snap()
    expect(matchPattern(s, { predicate: 'route', from: 'n3' }).edges.map((e) => e.id)).toEqual([
      'ed-11',
    ])
    expect(matchPattern(s, { predicate: 'route', to: 'n2' }).edges.map((e) => e.id)).toEqual([
      'ed-11',
    ])
  })

  it('没有边条件时返回节点间的诱导边', () => {
    const s = snap()
    const r = matchPattern(s, { classId: 'cls-sect' })
    expect(r.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(r.edges).toEqual([])
  })

  it('retracted / tombstone 边不参与', () => {
    const s = snap()
    const a = s.edges.find((x) => x.id === 'ed-1')
    if (a !== undefined) a.retracted = true
    const b = s.edges.find((x) => x.id === 'ed-2')
    if (b !== undefined) b.tombstone = true
    expect(matchPattern(s, { predicate: 'belongsTo' }).edges).toEqual([])
  })

  it('limit 下限 1：limit=0 也至少留一个节点', () => {
    expect(matchPattern(snap(), { limit: 0 }).nodes).toHaveLength(1)
  })
})

describe('findPath', () => {
  it('★ 找到最短路径；同长度取字典序（走 n1，不走 n4）', () => {
    const r = findPath(snap(), 'c1', 'n2')
    expect(r.found).toBe(true)
    expect(r.nodes.map((n) => n.id)).toEqual(['c1', 'n1', 'n2'])
    expect(r.edges.map((e) => e.id)).toEqual(['ed-1', 'ed-3'])
  })

  it('同一起点终点的结果稳定', () => {
    const first = findPath(snap(), 'c1', 'n2')
    const second = findPath(snap(), 'c1', 'n2')
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id))
  })

  it('maxDepth 限制 + 找不到返回 found=false', () => {
    expect(findPath(snap(), 'c1', 'n2', 1).found).toBe(false)
    expect(findPath(snap(), 'nope', 'n2').found).toBe(false)
    expect(findPath(snap(), 'c1', 'n2', Number.NaN).found).toBe(true)
  })

  it('起点即终点：返回单节点、零边', () => {
    const r = findPath(snap(), 'n1', 'n1')
    expect(r.found).toBe(true)
    expect(r.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(r.edges).toEqual([])
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

  it('★ 有向谓词不做反向推导', () => {
    // 只存在 n1→…→n3，反向不成立
    expect(explainFact(snap(), 'n3', 'ally', 'n1').found).toBe(false)
  })

  it('双向下路线反向也算直接边', () => {
    expect(explainFact(snap(), 'n3', 'route', 'n2')).toMatchObject({
      found: true,
      direct: true,
    })
  })

  it('传递推导最多 4 跳：第 5 跳不成立', () => {
    expect(explainFact(snap(), 'n1', 'ally', 'n6').found).toBe(true)
    expect(explainFact(snap(), 'n1', 'ally', 'n7').found).toBe(false)
  })

  it('instanceOf 走类闭包（子类实例也算）', () => {
    const s = snap()
    // 把 cn1 的类收窄成子类本身，逼 instanceOf 走闭包而不是 classOf 直接命中
    const patched: GraphSnapshot = {
      ...s,
      classOf: new Map([...s.classOf, ['cn1', ['cls-sword']]]),
    }
    expect(matchPattern(patched, { classId: 'cls-character' }).nodes.map((n) => n.id)).toContain(
      'cn1',
    )
    const r = explainFact(patched, 'cn1', 'instanceOf', 'cls-character')
    expect(r.found).toBe(true)
    expect(r.reason).toContain('子类')
  })
})
