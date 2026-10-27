import type { GraphEdge } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'
import { validateGraph } from './validate.js'

const edge = (over: Partial<GraphEdge>): GraphEdge => ({
  id: 'ed-aaaaaa',
  from: 'c1',
  predicate: 'instanceOf',
  to: 'cls-character',
  source: { kind: 'author' },
  createdAt: '2026-10-27T00:00:00.000Z',
  ...over,
})

function snap(edges: GraphEdge[], classesFile: GraphSource['classesFile'] = null) {
  const src: GraphSource = {
    characters: [
      { id: 'c1', projectId: 'p1', name: '林岚', role: 'protagonist', stateStale: false } as never,
    ],
    relations: [],
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
  it('★ 悬空边报 EDGE_ENDPOINT_MISSING；虚拟边不检查', () => {
    const s = snap([edge({ to: 'nobody' })])
    expect(validateGraph(s)).toContainEqual(
      expect.objectContaining({ code: 'EDGE_ENDPOINT_MISSING', subject: 'ed-aaaaaa' }),
    )
  })

  it('未知谓词报 EDGE_BAD_PREDICATE', () => {
    const s = snap([edge({ predicate: 'nope' })])
    expect(validateGraph(s)).toContainEqual(
      expect.objectContaining({ code: 'EDGE_BAD_PREDICATE', subject: 'ed-aaaaaa' }),
    )
  })

  it('同一 from/predicate/to/sinceChapter 重复报 DUP_EDGE', () => {
    const s = snap([edge({ id: 'ed-aaaaaa' }), edge({ id: 'ed-bbbbbb' })])
    expect(validateGraph(s).filter((i) => i.code === 'DUP_EDGE')).toHaveLength(1)
  })

  it('废止记录行不产生 DUP_EDGE（吊销不是重复断言）', () => {
    const s = snap([edge({ id: 'ed-aaaaaa' }), edge({ id: 'ed-bbbbbb', retracts: 'ed-aaaaaa' })])
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
