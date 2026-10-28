import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  explainFact,
  findPath,
  type GraphEdgeView,
  type GraphNode,
  type GraphPattern,
  type GraphSnapshot,
  matchPattern,
  type PatternResult,
} from '@inkloom/core'
import { Type } from 'typebox'
import { getGraphSnapshot } from '../services/ontology-service.js'
import { fail, ok } from './tool-result.js'

const READONLY = '图谱是只读视图；要改设定请用 write_element，不要在对话里改图。'

const QUERY_GRAPH = Type.Object({
  classId: Type.Optional(Type.String({ description: '类 id，例如 cls-character；含子类' })),
  nodeType: Type.Optional(
    Type.Union(
      ['character', 'group', 'place', 'rule', 'item', 'concept', 'class'].map((t) =>
        Type.Literal(t),
      ),
      { description: '节点类型' },
    ),
  ),
  predicate: Type.Optional(Type.String({ description: '谓词 id，例如 belongsTo / instanceOf' })),
  from: Type.Optional(Type.String({ description: '边的起点节点 id' })),
  to: Type.Optional(Type.String({ description: '边的终点节点 id（可为类 id）' })),
  attr: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: '属性相等过滤，值必须是字符串（如 {"tier":"一流"}）',
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: '默认 50' })),
})

const FIND_PATH = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: '默认 4' })),
})

const EXPLAIN_FACT = Type.Object({
  from: Type.String({ minLength: 1 }),
  predicate: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
})

function nameOf(snap: GraphSnapshot, id: string): string {
  return snap.nodes.get(id)?.name ?? snap.classes.find((c) => c.id === id)?.name ?? id
}

function renderQuery(result: PatternResult, snap: GraphSnapshot): string {
  const nodeLines = result.nodes.map(
    (n) => `- ${n.name}（${n.id}，${n.type}${n.virtual ? '，虚拟' : ''}）`,
  )
  const edgeLines = result.edges.map(
    (e) =>
      `- ${nameOf(snap, e.from)} —${e.predicate}→ ${nameOf(snap, e.to)}${e.virtual ? '（虚拟）' : ''}`,
  )
  const head = `${result.nodes.length} 个节点 · ${result.edges.length} 条边`
  return `${head}\n${nodeLines.join('\n')}${edgeLines.length > 0 ? `\n${edgeLines.join('\n')}` : ''}`
}

/** 给 details 的结构化副本：文本给模型看，details 给调试/后续 UI 看 */
function nodeFacts(nodes: GraphNode[]): Record<string, unknown>[] {
  return nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, virtual: n.virtual }))
}

function edgeFacts(edges: GraphEdgeView[]): Record<string, unknown>[] {
  return edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    predicate: e.predicate,
    virtual: e.virtual,
  }))
}

export function createGraphTools(): AgentTool[] {
  const queryGraph: AgentTool<typeof QUERY_GRAPH> = {
    name: 'query_graph',
    label: '查询图谱',
    description: `按类/类型/谓词/端点/属性查询本体图，返回节点与边。${READONLY}`,
    parameters: QUERY_GRAPH,
    execute: async (_id, params) => {
      const snap = await getGraphSnapshot().catch((e: unknown) => e as Error)
      if (snap instanceof Error) return fail(`图谱不可用：${snap.message}`)
      const pattern: GraphPattern = {
        ...(params.classId === undefined ? {} : { classId: params.classId }),
        ...(params.nodeType === undefined
          ? {}
          : { nodeType: params.nodeType as NonNullable<GraphPattern['nodeType']> }),
        ...(params.predicate === undefined ? {} : { predicate: params.predicate }),
        ...(params.from === undefined ? {} : { from: params.from }),
        ...(params.to === undefined ? {} : { to: params.to }),
        ...(params.attr === undefined ? {} : { attr: params.attr }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }
      const result = matchPattern(snap, pattern)
      if (result.nodes.length === 0 && result.edges.length === 0) {
        return fail('没有匹配的节点/边。可以放宽条件，或先用 read_book 看类与谓词。')
      }
      return ok(renderQuery(result, snap), {
        nodeCount: result.nodes.length,
        edgeCount: result.edges.length,
        nodes: nodeFacts(result.nodes),
        edges: edgeFacts(result.edges),
      })
    },
  }

  const findPathTool: AgentTool<typeof FIND_PATH> = {
    name: 'find_path',
    label: '查最短路径',
    description: `查两个节点之间边数最少的路径（最多 8 跳）。${READONLY}`,
    parameters: FIND_PATH,
    execute: async (_id, params) => {
      const snap = await getGraphSnapshot().catch((e: unknown) => e as Error)
      if (snap instanceof Error) return fail(`图谱不可用：${snap.message}`)
      const r = findPath(snap, params.from, params.to, params.maxDepth ?? 4)
      if (!r.found) {
        return fail(
          `没有找到 ${params.from} → ${params.to} 的路径（最多 ${params.maxDepth ?? 4} 跳）。可以用 query_graph 查它们各自的直接关系。`,
        )
      }
      const hops = r.edges.map((e, i) => {
        const a = nameOf(snap, r.nodes[i]?.id ?? e.from)
        const b = nameOf(snap, r.nodes[i + 1]?.id ?? e.to)
        const label = snap.predicates.find((p) => p.id === e.predicate)?.label ?? e.predicate
        // ★ BFS 不看方向：反向跨越时按边自身方向渲染；无向边没有「反向」一说
        const back = r.nodes[i]?.id !== e.from
        const backTag = back && e.undirected !== true ? '（反向）' : ''
        const line = back ? `${b} —${label}→ ${a}${backTag}` : `${a} —${label}→ ${b}`
        return `${i + 1}. ${line}${e.virtual ? '（虚拟）' : ''}`
      })
      if (r.edges.length === 0) {
        return ok('同一个节点，0 跳。', {
          found: true,
          hops: 0,
          nodes: nodeFacts(r.nodes),
          edges: [],
        })
      }
      return ok(
        `找到路径（${r.edges.length} 跳）：${r.nodes.map((n) => n.name).join(' → ')}\n${hops.join('\n')}`,
        { found: true, hops: r.edges.length, nodes: nodeFacts(r.nodes), edges: edgeFacts(r.edges) },
      )
    },
  }

  const explainFactTool: AgentTool<typeof EXPLAIN_FACT> = {
    name: 'explain_fact',
    label: '解释事实',
    description: `解释 from —predicate→ to 是否成立（直接边/传递/子类推导）。${READONLY}`,
    parameters: EXPLAIN_FACT,
    execute: async (_id, params) => {
      const snap = await getGraphSnapshot().catch((e: unknown) => e as Error)
      if (snap instanceof Error) return fail(`图谱不可用：${snap.message}`)
      const r = explainFact(snap, params.from, params.predicate, params.to)
      return r.found
        ? ok(r.reason, { direct: r.direct, virtual: r.virtual, via: r.via })
        : fail(r.reason)
    },
  }

  return [queryGraph, findPathTool, explainFactTool]
}
