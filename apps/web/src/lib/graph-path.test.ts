import { describe, expect, it } from 'vitest'
import type { OntologyEdgeRow } from '../api/types'
import { pathHops } from './graph-path'

function edge(
  over: Partial<OntologyEdgeRow> & { id: string; from: string; to: string },
): OntologyEdgeRow {
  return { predicate: 'rel:ally', virtual: false, ...over }
}

describe('pathHops', () => {
  it('按经过顺序给出每一跳，逆着边的存储方向走时标 back', () => {
    const hops = pathHops(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [edge({ id: 'e1', from: 'a', to: 'b' }), edge({ id: 'e2', from: 'c', to: 'b' })],
    )
    expect(hops).toEqual([
      { from: 'a', to: 'b', predicate: 'rel:ally', back: false, virtual: false, undirected: false },
      { from: 'b', to: 'c', predicate: 'rel:ally', back: true, virtual: false, undirected: false },
    ])
  })

  it('无向边的反向不算 back；节点序列缺失时退回边的端点', () => {
    const reversed = pathHops(
      [{ id: 'a' }, { id: 'b' }],
      [edge({ id: 'e1', from: 'b', to: 'a', undirected: true, virtual: true })],
    )
    expect(reversed).toEqual([
      { from: 'a', to: 'b', predicate: 'rel:ally', back: true, virtual: true, undirected: true },
    ])

    expect(pathHops([], [edge({ id: 'e2', from: 'x', to: 'y' })])).toEqual([
      { from: 'x', to: 'y', predicate: 'rel:ally', back: false, virtual: false, undirected: false },
    ])
    expect(pathHops([], [])).toEqual([])
  })
})
