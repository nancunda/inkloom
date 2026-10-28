import type { NodeType } from '@inkloom/shared'
import type { GraphEdgeView, GraphNode, GraphSnapshot } from './types.js'

/** 同步查询模式：节点条件与边条件可组合；全部为纯函数、零 IO */
export interface GraphPattern {
  classId?: string
  nodeType?: NodeType
  predicate?: string
  from?: string
  to?: string
  attr?: Record<string, string>
  limit?: number
}

export interface PatternResult {
  /** 满足节点条件的端点；边条件分支下，边的另一端可能不在 nodes 里（如 instanceOf 指向类 id） */
  nodes: GraphNode[]
  edges: GraphEdgeView[]
}

export interface PathResult {
  nodes: GraphNode[]
  edges: GraphEdgeView[]
  found: boolean
}

export interface ExplainResult {
  found: boolean
  direct: boolean
  via: string[]
  virtual: boolean
  reason: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_DEPTH = 4
const MAX_DEPTH = 8
/** explainFact 的传递推导最多看几跳：与 findPath 默认深度同口径 */
const FACT_HOPS = DEFAULT_DEPTH

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT)
}

function clampDepth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DEPTH
  return Math.min(Math.max(Math.trunc(n), 1), MAX_DEPTH)
}

/** 参与推理的边：废止行（tombstone）与已被吊销（retracted）的边都不算 */
function liveEdges(snap: GraphSnapshot): GraphEdgeView[] {
  return snap.edges.filter((e) => e.tombstone !== true && e.retracted !== true)
}

/** 类闭包：自己 + 所有子孙类（instanceOf 指向子类，父类查询要能带出来） */
function classClosure(snap: GraphSnapshot, classId: string): Set<string> {
  const out = new Set<string>([classId])
  for (const child of snap.subclasses.get(classId) ?? []) out.add(child)
  return out
}

function nodeMatches(snap: GraphSnapshot, n: GraphNode, p: GraphPattern): boolean {
  if (p.nodeType !== undefined && n.type !== p.nodeType) return false
  if (p.classId !== undefined) {
    const closure = classClosure(snap, p.classId)
    const classes = snap.classOf.get(n.id) ?? []
    if (!classes.some((c) => closure.has(c))) return false
  }
  if (p.attr !== undefined) {
    for (const [k, v] of Object.entries(p.attr)) {
      if (n.attrs[k] !== v) return false
    }
  }
  return true
}

function hasEdgeCond(p: GraphPattern): boolean {
  return p.predicate !== undefined || p.from !== undefined || p.to !== undefined
}

/**
 * 节点条件与边条件可组合：
 * - 有边条件 → 返回匹配边 + 两端节点（limit 截断边数）；
 * - 没有边条件 → 返回匹配节点 + 它们之间的诱导边（limit 截断节点数）。
 */
export function matchPattern(snap: GraphSnapshot, pattern: GraphPattern): PatternResult {
  const limit = clampLimit(pattern.limit)
  const edges = liveEdges(snap)

  if (hasEdgeCond(pattern)) {
    // ★ 双向路线匹配忽略方向（types.ts 的 undirected 契约）
    const fromHit = (e: GraphEdgeView): boolean =>
      pattern.from === undefined ||
      e.from === pattern.from ||
      (e.undirected === true && e.to === pattern.from)
    const toHit = (e: GraphEdgeView): boolean =>
      pattern.to === undefined ||
      e.to === pattern.to ||
      (e.undirected === true && e.from === pattern.to)
    const picked = edges
      .filter(
        (e) =>
          (pattern.predicate === undefined || e.predicate === pattern.predicate) &&
          fromHit(e) &&
          toHit(e),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
    const ids = new Set<string>()
    for (const e of picked) {
      ids.add(e.from)
      ids.add(e.to)
    }
    const nodes = [...ids]
      .map((id) => snap.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .filter((n) => nodeMatches(snap, n, pattern))
    return { nodes, edges: picked }
  }

  const nodes = [...snap.nodes.values()]
    .filter((n) => nodeMatches(snap, n, pattern))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id))
    .slice(0, limit)
  const kept = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    edges: edges
      .filter((e) => kept.has(e.from) && kept.has(e.to))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/**
 * 邻接表：`bidirectional` 决定反向是否可走。
 * - findPath 传 `() => true`（探索「怎么连上的」，不看方向）；
 * - explainFact 的传递推导只沿有向边走，除非谓词/边本身声明无向。
 */
function adjacency(
  snap: GraphSnapshot,
  bidirectional: (e: GraphEdgeView) => boolean,
): Map<string, { to: string; edge: GraphEdgeView }[]> {
  const out = new Map<string, { to: string; edge: GraphEdgeView }[]>()
  for (const e of liveEdges(snap)) {
    const a = out.get(e.from) ?? []
    a.push({ to: e.to, edge: e })
    out.set(e.from, a)
    if (!bidirectional(e)) continue
    const b = out.get(e.to) ?? []
    b.push({ to: e.from, edge: e })
    out.set(e.to, b)
  }
  for (const list of out.values()) {
    list.sort((x, y) => x.to.localeCompare(y.to) || x.edge.id.localeCompare(y.edge.id))
  }
  return out
}

/** BFS 最短路径（边数最少）；同长度按邻接表排序保证结果稳定 */
export function findPath(
  snap: GraphSnapshot,
  from: string,
  to: string,
  maxDepth = DEFAULT_DEPTH,
): PathResult {
  const depthCap = clampDepth(maxDepth)
  if (from === to) {
    const n = snap.nodes.get(from)
    return { nodes: n === undefined ? [] : [n], edges: [], found: n !== undefined }
  }
  const adj = adjacency(snap, () => true)
  const prev = new Map<string, { from: string; edge: GraphEdgeView }>()
  const depth = new Map<string, number>([[from, 0]])
  const queue = [from]
  let found = false

  while (queue.length > 0) {
    const cur = queue.shift() as string
    const d = depth.get(cur) ?? 0
    if (d >= depthCap) continue
    for (const step of adj.get(cur) ?? []) {
      if (depth.has(step.to)) continue
      depth.set(step.to, d + 1)
      prev.set(step.to, { from: cur, edge: step.edge })
      if (step.to === to) {
        found = true
        break
      }
      queue.push(step.to)
    }
    if (found) break
  }

  if (!found) return { nodes: [], edges: [], found: false }

  const nodeIds: string[] = []
  const edges: GraphEdgeView[] = []
  let cursor = to
  for (;;) {
    nodeIds.push(cursor)
    const p = prev.get(cursor)
    if (p === undefined) break
    edges.push(p.edge)
    cursor = p.from
  }
  nodeIds.reverse()
  edges.reverse()
  const nodes = nodeIds
    .map((id) => snap.nodes.get(id))
    .filter((n): n is GraphNode => n !== undefined)
  // 端点可能只存在于边里（悬空节点）：不能返回 found:false 却带着半截路径
  if (nodes.length !== nodeIds.length) return { nodes: [], edges: [], found: false }
  return { nodes, edges, found: true }
}

function predicateLabel(snap: GraphSnapshot, predicate: string): string {
  return snap.predicates.find((p) => p.id === predicate)?.label ?? predicate
}

function nameOf(snap: GraphSnapshot, id: string): string {
  return snap.nodes.get(id)?.name ?? snap.classes.find((c) => c.id === id)?.name ?? id
}

/** 解释一条事实：直接边 → instanceOf 类闭包 → 传递谓词多跳 → 不存在 */
export function explainFact(
  snap: GraphSnapshot,
  from: string,
  predicate: string,
  to: string,
): ExplainResult {
  const label = predicateLabel(snap, predicate)
  const direct = liveEdges(snap).find(
    (e) =>
      e.predicate === predicate &&
      ((e.from === from && e.to === to) ||
        (e.undirected === true && e.from === to && e.to === from)),
  )
  if (direct !== undefined) {
    return {
      found: true,
      direct: true,
      via: [from, to],
      virtual: direct.virtual,
      reason: `直接边：${nameOf(snap, from)} —${label}→ ${nameOf(snap, to)}${direct.virtual ? '（既有数据投影的虚拟边）' : ''}`,
    }
  }

  if (predicate === 'instanceOf') {
    // ★ spec §5.5：子类实例按父类查也算——不能只看 classOf 是否直接含目标类
    const closure = classClosure(snap, to)
    const classes = snap.classOf.get(from) ?? []
    if (classes.some((c) => closure.has(c))) {
      return {
        found: true,
        direct: false,
        via: [from, to],
        virtual: false,
        reason: `子类推导：${nameOf(snap, from)} 属于「${nameOf(snap, to)}」（含子类）`,
      }
    }
  }

  const transitive = snap.predicates.find((p) => p.id === predicate)?.transitive === true
  if (transitive) {
    const def = snap.predicates.find((p) => p.id === predicate)
    // 有向谓词只沿边方向推导，否则会把「n3 —ally→ n1」这种不存在的反向事实说成成立
    const adj = adjacency(snap, (e) => e.undirected === true || def?.directed === false)
    const visited = new Set<string>([from])
    const queue: { id: string; hops: string[] }[] = [{ id: from, hops: [from] }]
    while (queue.length > 0) {
      const cur = queue.shift() as { id: string; hops: string[] }
      if (cur.hops.length - 1 >= FACT_HOPS) continue
      for (const step of adj.get(cur.id) ?? []) {
        if (step.edge.predicate !== predicate) continue
        if (visited.has(step.to)) continue
        const hops = [...cur.hops, step.to]
        if (step.to === to) {
          return {
            found: true,
            direct: false,
            via: hops,
            virtual: step.edge.virtual,
            reason: `经 ${hops.length - 1} 跳（传递关系 ${label}）：${hops.map((id) => nameOf(snap, id)).join(' → ')}`,
          }
        }
        visited.add(step.to)
        queue.push({ id: step.to, hops })
      }
    }
  }

  return {
    found: false,
    direct: false,
    via: [],
    virtual: false,
    reason: `没有找到：${nameOf(snap, from)} —${label}→ ${nameOf(snap, to)}（直接边与已知推导都不成立）`,
  }
}
