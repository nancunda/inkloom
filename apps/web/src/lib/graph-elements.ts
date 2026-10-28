import type { OntologyGraphData } from '../api/types'

/** rel:<kind> 的中文（与详情栏/图例同一口径，只有这一份） */
export const REL_LABEL: Record<string, string> = {
  master: '师徒',
  disciple: '弟子',
  kin: '亲族',
  ally: '同盟',
  enemy: '敌对',
  rival: '竞争',
  lover: '情爱',
}

export const TYPE_COLOR: Record<string, string> = {
  character: '#1f2937',
  group: '#b45309',
  place: '#0f766e',
  rule: '#be123c',
  item: '#7c3aed',
  concept: '#4b5563',
  class: '#a1a1a1',
}

export interface GraphElementNodeData {
  id: string
  label: string
  kind: 'class' | 'instance'
  nodeType?: string
  classId?: string
  color?: string
  instanceCount?: number
  virtual?: boolean
  parent?: string
}

export interface GraphElementEdgeData {
  id: string
  source: string
  target: string
  label: string
  predicate: string
  virtual: boolean
  retracted: boolean
}

export interface GraphElements {
  nodes: { data: GraphElementNodeData }[]
  edges: { data: GraphElementEdgeData }[]
}

export function predicateLabel(predicate: string, labels: Map<string, string>): string {
  if (predicate.startsWith('rel:')) {
    const kind = predicate.slice(4)
    return REL_LABEL[kind] ?? kind
  }
  return labels.get(predicate) ?? predicate
}

/**
 * ★ 类表里查不到的类不能直接当 parent：Cytoscape 会报父节点不存在。
 * 挂到「概念」桶里，与没有类信息的节点同待遇。
 */
function parentOf(n: OntologyGraphData['nodes'][number], classIds: Set<string>): string {
  const candidate = n.classIds.at(-1) ?? 'cls-concept'
  return candidate === 'cls-concept' || classIds.has(candidate) ? candidate : 'cls-concept'
}

/**
 * GraphSnapshot（HTTP 返回的扁平数组）→ Cytoscape elements。
 * ★ 只在这里做投影：后端不加 elements，避免两套真相。
 */
export function toGraphElements(graph: OntologyGraphData): GraphElements {
  const labels = new Map(graph.predicates.map((p) => [p.id, p.label]))
  const classIds = new Set(graph.classes.map((c) => c.id))
  const nodes: { data: GraphElementNodeData }[] = []

  for (const c of graph.classes) {
    nodes.push({
      data: {
        id: c.id,
        label: c.name,
        kind: 'class',
        ...(c.instanceCount === undefined ? {} : { instanceCount: c.instanceCount }),
      },
    })
  }
  const needRoot = graph.nodes.some((n) => parentOf(n, classIds) === 'cls-concept')
  if (needRoot && !classIds.has('cls-concept')) {
    nodes.push({ data: { id: 'cls-concept', label: '概念', kind: 'class' } })
  }

  const usedIds = new Set(nodes.map((n) => n.data.id))
  for (const n of graph.nodes) {
    const parent = parentOf(n, classIds)
    const rawClass = n.classIds.at(-1)
    // 类 id 与实例 id 撞车时 Cytoscape 会直接报「第二个同 id 元素」：类优先，实例跳过
    if (usedIds.has(n.id)) continue
    usedIds.add(n.id)
    nodes.push({
      data: {
        id: n.id,
        label: n.name,
        kind: 'instance',
        nodeType: n.type,
        ...(rawClass === undefined ? {} : { classId: rawClass }),
        color: TYPE_COLOR[n.type] ?? '#737373',
        ...(n.virtual ? { virtual: true } : {}),
        parent,
      },
    })
  }

  const nodeIds = usedIds
  const edges = graph.edges
    .filter(
      (e) =>
        e.tombstone !== true &&
        e.predicate !== 'instanceOf' &&
        nodeIds.has(e.from) &&
        nodeIds.has(e.to),
    )
    .map((e) => ({
      data: {
        id: e.id,
        source: e.from,
        target: e.to,
        label: predicateLabel(e.predicate, labels),
        predicate: e.predicate,
        virtual: e.virtual === true,
        retracted: e.retracted === true,
      },
    }))

  return { nodes, edges }
}

/**
 * ★ 当前数据只有 instanceOf 会指向类；所以类框只跟实例走。
 * 将来如果出现类级关系的边（非 instanceOf 指向类），这里要改成「边端点里的类也保留」。
 */
export function filterElements(
  elements: GraphElements,
  filter: { nodeTypes?: ReadonlySet<string>; predicates?: ReadonlySet<string> },
): GraphElements {
  const types =
    filter.nodeTypes === undefined || filter.nodeTypes.size === 0 ? null : filter.nodeTypes
  const instances = elements.nodes.filter(
    (n) =>
      n.data.kind === 'instance' &&
      (types === null || (n.data.nodeType !== undefined && types.has(n.data.nodeType))),
  )
  // ★ 分组框只在还有实例时保留；空框既占地方，又会让人以为过滤没生效
  const parentIds = new Set<string>()
  for (const n of instances) {
    if (n.data.parent !== undefined) parentIds.add(n.data.parent)
  }
  const classes = elements.nodes.filter((n) => n.data.kind === 'class' && parentIds.has(n.data.id))
  const nodes = [...classes, ...instances]
  const ids = new Set(nodes.map((n) => n.data.id))
  const edges = elements.edges.filter(
    (e) =>
      ids.has(e.data.source) &&
      ids.has(e.data.target) &&
      (filter.predicates === undefined ||
        filter.predicates.size === 0 ||
        filter.predicates.has(e.data.predicate)),
  )
  return { nodes, edges }
}

/**
 * BFS：锚点 N 跳内的节点（含锚点）；hops=0 只回锚点。
 * ★ 这里与画布同口径：废止边仍然画着，所以也算一跳；路径查询才排除废止边。
 */
export function nodesWithinHops(
  elements: GraphElements,
  anchor: string,
  hops: number,
): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of elements.edges) {
    const a = adj.get(e.data.source) ?? []
    a.push(e.data.target)
    adj.set(e.data.source, a)
    const b = adj.get(e.data.target) ?? []
    b.push(e.data.source)
    adj.set(e.data.target, b)
  }
  const seen = new Set<string>([anchor])
  let frontier = [anchor]
  for (let d = 0; d < hops; d += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const to of adj.get(id) ?? []) {
        if (seen.has(to)) continue
        seen.add(to)
        next.push(to)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return seen
}

/**
 * 高亮用：给定节点集合，返回真实存在的节点 + 两端都在集合内的边；其余元素交给画布淡出。
 * ★ 集合里可能混进已被筛掉的 id（路径结果、N 跳邻居），这里必须收口，否则高亮落空还压暗全图。
 */
export function inducedIds(elements: GraphElements, nodeIds: ReadonlySet<string>): string[] {
  const present = new Set(elements.nodes.map((n) => n.data.id))
  const out = new Set<string>([...nodeIds].filter((id) => present.has(id)))
  for (const e of elements.edges) {
    if (nodeIds.has(e.data.source) && nodeIds.has(e.data.target)) out.add(e.data.id)
  }
  return [...out]
}

/** 按名字/ID 搜实例节点（类节点不参与，避免把整个分组框高亮） */
export function searchNodes(elements: GraphElements, text: string): string[] {
  const q = text.trim().toLowerCase()
  if (q.length === 0) return []
  return elements.nodes
    .filter((n) => n.data.kind === 'instance')
    .filter((n) => n.data.label.toLowerCase().includes(q) || n.data.id.toLowerCase().includes(q))
    .map((n) => n.data.id)
}
