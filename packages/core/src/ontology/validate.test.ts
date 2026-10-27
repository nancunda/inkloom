import type { CharacterRelation, ClassesFile, GraphEdge } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'
import { validateGraph } from './validate.js'

const edge = (over: Partial<GraphEdge> = {}): GraphEdge => ({
  id: 'ed-aaaaaa',
  from: 'c1',
  predicate: 'instanceOf',
  to: 'cls-character',
  source: { kind: 'author' },
  createdAt: '2026-10-27T00:00:00.000Z',
  ...over,
})

const classesWithCharacter: ClassesFile = {
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

function snap(
  edges: GraphEdge[],
  classesFile: GraphSource['classesFile'] = null,
  relations: CharacterRelation[] = [],
) {
  const src: GraphSource = {
    characters: [
      { id: 'c1', projectId: 'p1', name: '林岚', role: 'protagonist', stateStale: false } as never,
      { id: 'c2', projectId: 'p1', name: '裴无咎', role: 'supporting', stateStale: false } as never,
    ],
    relations,
    locations: [],
    routes: [],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [],
    edges,
    classesFile,
    builtFrom: { files: [], mtimeMax: 0 },
  }
  return buildGraph(src)
}

describe('validateGraph', () => {
  it('★ 合法图零 issue（instanceOf 指向类 id 不算悬空）', () => {
    const s = snap([edge()], classesWithCharacter)
    expect(validateGraph(s)).toEqual([])
  })

  it('悬空边报 EDGE_ENDPOINT_MISSING，只提示不阻断', () => {
    const s = snap([edge({ to: 'nobody' })])
    expect(validateGraph(s)).toContainEqual(
      expect.objectContaining({
        code: 'EDGE_ENDPOINT_MISSING',
        subject: 'ed-aaaaaa',
        severity: 'warning',
      }),
    )
  })

  it('未知谓词报 EDGE_BAD_PREDICATE；虚拟边的 rel:* 谓词不报', () => {
    const bad = snap([edge({ predicate: 'nope' })], classesWithCharacter)
    expect(validateGraph(bad)).toContainEqual(
      expect.objectContaining({ code: 'EDGE_BAD_PREDICATE', subject: 'ed-aaaaaa' }),
    )
    const virtual = snap([], classesWithCharacter, [
      {
        id: 'r1',
        projectId: 'p1',
        fromId: 'c1',
        toId: 'c2',
        kind: 'enemy',
        strength: 3,
      } as CharacterRelation,
    ])
    expect(validateGraph(virtual).map((i) => i.code)).not.toContain('EDGE_BAD_PREDICATE')
  })

  it('同一 from/predicate/to/sinceChapter 重复报 DUP_EDGE，evidence 指向先出现的那条', () => {
    const s = snap([edge({ id: 'ed-aaaaaa' }), edge({ id: 'ed-bbbbbb' })], classesWithCharacter)
    const dups = validateGraph(s).filter((i) => i.code === 'DUP_EDGE')
    expect(dups).toHaveLength(1)
    expect(dups[0]).toMatchObject({
      subject: 'ed-bbbbbb',
      evidence: 'ed-aaaaaa',
      severity: 'error',
    })
  })

  it('废止记录行不产生 DUP_EDGE（它只用于吊销）', () => {
    const s = snap(
      [
        edge({ id: 'ed-aaaaaa' }),
        // 三要素与 ed-aaaaaa 相同，但吊销的是别的边：只有 tombstone 守卫能挡住误报
        edge({ id: 'ed-bbbbbb', retracts: 'ed-000000' }),
      ],
      classesWithCharacter,
    )
    expect(validateGraph(s).filter((i) => i.code === 'DUP_EDGE')).toHaveLength(0)
  })

  it('被吊销的边不参与重复判定，吊销后可重新断言', () => {
    const s = snap(
      [
        edge({ id: 'ed-aaaaaa' }),
        edge({ id: 'ed-cccccc', retracts: 'ed-aaaaaa' }),
        edge({ id: 'ed-bbbbbb' }),
      ],
      classesWithCharacter,
    )
    expect(validateGraph(s).filter((i) => i.code === 'DUP_EDGE')).toHaveLength(0)
  })

  it('父类缺失与类环', () => {
    const s = snap([], {
      version: 1,
      classes: [
        {
          id: 'cls-a',
          name: 'A',
          parentId: 'cls-missing',
          kind: 'concept',
          properties: [],
          rules: [],
        },
        { id: 'cls-b', name: 'B', parentId: 'cls-c', kind: 'concept', properties: [], rules: [] },
        { id: 'cls-c', name: 'C', parentId: 'cls-b', kind: 'concept', properties: [], rules: [] },
      ],
      predicates: [],
    })
    const codes = validateGraph(s).map((i) => i.code)
    expect(codes).toContain('CLASS_PARENT_MISSING')
    expect(codes).toContain('CLASS_CYCLE')
  })
})
