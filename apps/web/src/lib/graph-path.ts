import type { OntologyEdgeRow } from '../api/types'

export interface PathHop {
  from: string
  to: string
  predicate: string
  /** 走的方向与边存储的方向相反（无向边不算反向） */
  back: boolean
  undirected: boolean
  virtual: boolean
}

/**
 * 路径 → 逐跳视图。
 * ★ 服务端返回的边是按存储方向（from→to）给的，路径可能是逆着走的；
 *   面板必须按 nodes 的顺序渲染，否则第二跳会读成「终点 → 上一站」。
 */
export function pathHops(
  nodes: readonly { id: string }[],
  edges: readonly OntologyEdgeRow[],
): PathHop[] {
  return edges.map((e, i) => {
    const from = nodes[i]?.id ?? e.from
    const to = nodes[i + 1]?.id ?? e.to
    return {
      from,
      to,
      predicate: e.predicate,
      back: e.from !== from,
      undirected: e.undirected === true,
      virtual: e.virtual,
    }
  })
}
