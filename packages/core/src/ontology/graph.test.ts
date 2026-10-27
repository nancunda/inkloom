import type {
  CharacterRelation,
  ClassesFile,
  GraphEdge,
  Location,
  OntologyNode,
  Route,
} from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'

const char = (id: string, name: string) =>
  ({
    id,
    projectId: 'p1',
    name,
    role: 'supporting',
    stateStale: false,
  }) as const

function source(over: Partial<GraphSource> = {}): GraphSource {
  return {
    characters: [char('c1', '林岚'), char('c2', '裴无咎')],
    relations: [
      {
        id: 'r1',
        projectId: 'p1',
        fromId: 'c1',
        toId: 'c2',
        kind: 'enemy',
        strength: 4,
        sinceChapter: 3,
      } as CharacterRelation,
    ],
    locations: [{ id: 'l1', projectId: 'p1', name: '寒山关', type: 'mountain' } as Location],
    routes: [
      {
        id: 'rt1',
        projectId: 'p1',
        fromId: 'l1',
        toId: 'l2',
        mode: 'walk',
        days: 3,
        bidirectional: true,
      } as Route,
    ],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [],
    edges: [],
    classesFile: null,
    builtFrom: { files: [], mtimeMax: 0 },
    ...over,
  }
}

describe('buildGraph', () => {
  it('★ 现有实体变成虚拟节点，关系/路线变成虚拟边', () => {
    const g = buildGraph(source())
    expect(g.nodes.get('c1')).toMatchObject({ type: 'character', name: '林岚', virtual: true })
    expect(g.nodes.get('l1')).toMatchObject({ type: 'place', virtual: true })
    const rel = g.edges.find((e) => e.id === 'rel-r1')
    expect(rel).toMatchObject({ from: 'c1', predicate: 'rel:enemy', to: 'c2', virtual: true })
    const route = g.edges.find((e) => e.id === 'rt-rt1')
    expect(route).toMatchObject({ predicate: 'route', undirected: true, virtual: true })
    expect(g.classOf.get('c1')).toContain('cls-character')
  })

  it('★ 附加节点进图，instanceOf + 父类形成类闭包', () => {
    const classes: ClassesFile = {
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
        {
          id: 'cls-group',
          name: '组织',
          parentId: null,
          kind: 'group',
          properties: [],
          rules: [],
        },
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
        {
          id: 'instanceOf',
          label: '属于类',
          domain: 'any',
          range: 'class',
          directed: true,
          transitive: false,
        },
      ],
    }
    const node: OntologyNode = {
      id: 'grp-qingyun',
      type: 'group',
      name: '青云宗',
      aliases: [],
      summary: '',
      attrs: {},
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    const edge: GraphEdge = {
      id: 'ed-123abc',
      from: 'grp-qingyun',
      predicate: 'instanceOf',
      to: 'cls-sect',
      source: { kind: 'author' },
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    const g = buildGraph(source({ nodes: [node], edges: [edge], classesFile: classes }))
    expect(g.nodes.get('grp-qingyun')?.virtual).toBe(false)
    expect(g.classOf.get('grp-qingyun')).toEqual(['cls-group', 'cls-sect'])
  })

  it('被 retracts 指向的边标 retracted', () => {
    const edges: GraphEdge[] = [
      {
        id: 'ed-aaaaaa',
        from: 'c1',
        predicate: 'instanceOf',
        to: 'cls-character',
        source: { kind: 'author' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-bbbbbb',
        from: 'c1',
        predicate: 'instanceOf',
        to: 'cls-character',
        retracts: 'ed-aaaaaa',
        source: { kind: 'author' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
    ]
    const g = buildGraph(source({ edges }))
    expect(g.edges.find((e) => e.id === 'ed-aaaaaa')?.retracted).toBe(true)
    expect(g.edges.find((e) => e.id === 'ed-bbbbbb')?.retracted).toBe(false)
  })

  it('重复节点记 warning，不中断构建', () => {
    const node: OntologyNode = {
      id: 'c1',
      type: 'group',
      name: '撞车',
      aliases: [],
      summary: '',
      attrs: {},
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    const g = buildGraph(source({ nodes: [node] }))
    expect(g.issues).toContainEqual(
      expect.objectContaining({ code: 'DUP_NODE', subject: 'c1', severity: 'warning' }),
    )
    expect(g.nodes.get('c1')?.name).toBe('林岚')
  })
})
