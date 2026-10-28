import { describe, expect, it } from 'vitest'
import type { OntologyGraphData } from '../api/types'
import { filterElements, nodesWithinHops, searchNodes, toGraphElements } from './graph-elements'

function graph(over: Partial<OntologyGraphData> = {}): OntologyGraphData {
  return {
    nodes: [
      {
        id: 'c1',
        type: 'character',
        name: '林岚',
        attrs: {},
        virtual: true,
        classIds: ['cls-character'],
      },
      {
        id: 'grp',
        type: 'group',
        name: '青云宗',
        attrs: {},
        virtual: false,
        classIds: ['cls-group', 'cls-sect'],
      },
      {
        id: 'l1',
        type: 'place',
        name: '寒山关',
        attrs: {},
        virtual: true,
        classIds: ['cls-place'],
      },
    ],
    edges: [
      { id: 'e-inst', from: 'grp', predicate: 'instanceOf', to: 'cls-sect', virtual: false },
      { id: 'e-belong', from: 'c1', predicate: 'belongsTo', to: 'grp', virtual: false },
      {
        id: 'e-retract',
        from: 'c1',
        predicate: 'enemy',
        to: 'l1',
        virtual: false,
        retracted: true,
      },
      { id: 'e-tomb', from: 'c1', predicate: 'ally', to: 'l1', virtual: false, tombstone: true },
      { id: 'e-dangling', from: 'c1', predicate: 'ally', to: 'ghost', virtual: true },
    ],
    classes: [
      {
        id: 'cls-character',
        name: '人物',
        parentId: null,
        kind: 'character',
        properties: [],
        rules: [],
      },
      { id: 'cls-group', name: '组织', parentId: null, kind: 'group', properties: [], rules: [] },
      {
        id: 'cls-sect',
        name: '宗门',
        parentId: 'cls-group',
        kind: 'group',
        properties: [],
        rules: [],
      },
    ],
    predicates: [
      { id: 'belongsTo', label: '隶属', domain: 'any', range: 'any', directed: true },
      { id: 'enemy', label: '敌对', domain: 'any', range: 'any', directed: true },
    ],
    issues: [],
    warnings: [],
    total: 3,
    truncated: false,
    signature: 's',
    builtAt: '2026-10-27T00:00:00.000Z',
    ...over,
  }
}

describe('toGraphElements', () => {
  it('★ 类变分组节点，实例挂最具体的类；instanceOf 不画', () => {
    const g = toGraphElements(graph())
    const classIds = g.nodes.filter((n) => n.data.kind === 'class').map((n) => n.data.id)
    expect(classIds).toEqual(['cls-character', 'cls-group', 'cls-sect', 'cls-concept'])

    expect(g.nodes.find((n) => n.data.id === 'grp')?.data.parent).toBe('cls-sect')
    expect(g.nodes.find((n) => n.data.id === 'c1')?.data.parent).toBe('cls-character')

    expect(g.edges.map((e) => e.data.predicate)).not.toContain('instanceOf')
  })

  it('★ 缺失的类补一个 cls-concept；悬空边与 tombstone 不画', () => {
    const g = toGraphElements(graph())
    expect(g.nodes.find((n) => n.data.id === 'cls-concept')).toMatchObject({
      data: { kind: 'class', label: '概念' },
    })
    expect(g.nodes.find((n) => n.data.id === 'l1')?.data.parent).toBe('cls-concept')
    expect(g.edges.map((e) => e.data.id)).toEqual(['e-belong', 'e-retract'])
  })

  it('边标签用中文谓词；虚拟/废止带标记', () => {
    const g = toGraphElements(graph())
    expect(g.edges.find((e) => e.data.id === 'e-belong')?.data.label).toBe('隶属')
    expect(g.edges.find((e) => e.data.id === 'e-retract')?.data.retracted).toBe(true)
  })
})

describe('filterElements / hops / search', () => {
  it('按类型与谓词过滤：空了的类分组框一并收起，边两端都得在', () => {
    const g = toGraphElements(graph())
    const out = filterElements(g, { nodeTypes: new Set(['character', 'group']) })
    // c1 挂 cls-character、grp 挂 cls-sect；cls-group 没有存活实例，应被收起
    expect(out.nodes.map((n) => n.data.id)).toEqual(['cls-character', 'cls-sect', 'c1', 'grp'])
    expect(out.edges.map((e) => e.data.id)).toEqual(['e-belong'])

    const noEnemy = filterElements(g, { predicates: new Set(['belongsTo']) })
    expect(noEnemy.edges.map((e) => e.data.id)).toEqual(['e-belong'])
  })

  it('★ N 跳邻居含锚点本身', () => {
    const g = toGraphElements(graph())
    expect([...nodesWithinHops(g, 'c1', 1)].sort()).toEqual(['c1', 'grp', 'l1'])
    expect([...nodesWithinHops(g, 'c1', 0)]).toEqual(['c1'])
  })

  it('搜名字与 id，大小写不敏感', () => {
    const g = toGraphElements(graph())
    expect(searchNodes(g, '青云')).toEqual(['grp'])
    expect(searchNodes(g, 'C1')).toEqual(['c1'])
    expect(searchNodes(g, '')).toEqual([])
  })
})
