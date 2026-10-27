import type {
  Character,
  ClassDef,
  Location,
  NodeType,
  PlotThread,
  Route,
  StoryArc,
  WorldRule,
} from '@inkloom/shared'
import { DEFAULT_CLASSES_FILE } from './defaults.js'
import type { GraphEdgeView, GraphIssue, GraphNode, GraphSnapshot, GraphSource } from './types.js'

export type {
  GraphEdgeView,
  GraphIssue,
  GraphNode,
  GraphSnapshot,
  GraphSource,
} from './types.js'

const DEFAULT_CLASS_BY_TYPE: Partial<Record<NodeType, string>> = {
  character: 'cls-character',
  group: 'cls-group',
  place: 'cls-place',
  rule: 'cls-rule',
  item: 'cls-item',
  concept: 'cls-concept',
}

function compact(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v.length > 0) out[k] = v
  }
  return out
}

/** 从类本身往上走，返回祖先 id（防环） */
function classAncestors(id: string, byId: Map<string, ClassDef>): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)?.parentId ?? null
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const def = byId.get(cur)
    if (def === undefined) break
    out.push(cur)
    cur = def.parentId
  }
  return out
}

function characterNode(c: Character): GraphNode {
  return {
    id: c.id,
    type: 'character',
    name: c.name,
    attrs: compact({
      role: c.role,
      personality: c.personality,
      motivation: c.motivation,
      curLocation: c.curLocation,
      curMental: c.curMental,
      stateChapter: c.stateChapter === undefined ? undefined : String(c.stateChapter),
    }),
    virtual: true,
    sourceFile: 'characters/index.json',
  }
}

function locationNode(l: Location): GraphNode {
  return {
    id: l.id,
    type: 'place',
    name: l.name,
    attrs: compact({ kind: l.type, region: l.region }),
    virtual: true,
    sourceFile: 'world/locations.json',
  }
}

function ruleNode(r: WorldRule): GraphNode {
  return {
    id: r.id,
    type: 'rule',
    name: r.name,
    attrs: compact({ category: r.category, priority: r.priority }),
    virtual: true,
    sourceFile: 'world/rules.json',
  }
}

function threadNode(t: PlotThread): GraphNode {
  return {
    id: t.id,
    type: 'concept',
    name: t.title,
    attrs: compact({ kind: 'thread', status: t.status }),
    virtual: true,
    sourceFile: 'story/threads.json',
  }
}

function arcNode(a: StoryArc): GraphNode {
  return {
    id: a.id,
    type: 'concept',
    name: a.name,
    attrs: compact({
      kind: 'arc',
      startChapter: String(a.startChapter),
      endChapter: String(a.endChapter),
      purpose: a.purpose,
    }),
    virtual: true,
    sourceFile: 'story/arcs.json',
  }
}

function routeEdge(r: Route): GraphEdgeView {
  return {
    id: `rt-${r.id}`,
    from: r.fromId,
    predicate: 'route',
    to: r.toId,
    source: { kind: 'author', ref: 'world/routes.json' },
    virtual: true,
    undirected: r.bidirectional,
    sourceFile: 'world/routes.json',
  }
}

export function buildGraph(src: GraphSource): GraphSnapshot {
  const classesFile = src.classesFile ?? DEFAULT_CLASSES_FILE
  const classById = new Map(classesFile.classes.map((c) => [c.id, c]))
  const nodes = new Map<string, GraphNode>()
  const duplicateNodeIds: string[] = []

  const add = (node: GraphNode): void => {
    if (nodes.has(node.id)) {
      duplicateNodeIds.push(node.id)
      return
    }
    nodes.set(node.id, node)
  }

  for (const c of src.characters) add(characterNode(c))
  for (const l of src.locations) add(locationNode(l))
  for (const r of src.rules) add(ruleNode(r))
  for (const t of src.threads) add(threadNode(t))
  for (const a of src.arcs) add(arcNode(a))
  for (const n of src.nodes) {
    add({
      id: n.id,
      type: n.type,
      name: n.name,
      aliases: n.aliases,
      attrs: n.attrs,
      virtual: false,
      sourceFile: 'world/ontology/nodes.jsonl',
    })
  }

  const edges: GraphEdgeView[] = []
  for (const r of src.relations) {
    edges.push({
      id: `rel-${r.id}`,
      from: r.fromId,
      predicate: `rel:${r.kind}`,
      to: r.toId,
      ...(r.sinceChapter === undefined ? {} : { sinceChapter: r.sinceChapter }),
      ...(r.untilChapter === undefined ? {} : { untilChapter: r.untilChapter }),
      source: { kind: 'author', ref: 'characters/relations.json' },
      virtual: true,
      sourceFile: 'characters/relations.json',
    })
  }
  for (const r of src.routes) edges.push(routeEdge(r))

  const retracted = new Set(
    src.edges.map((e) => e.retracts).filter((v): v is string => v !== undefined),
  )
  for (const e of src.edges) {
    edges.push({
      ...e,
      virtual: false,
      retracted: retracted.has(e.id),
      sourceFile: 'world/ontology/edges.jsonl',
    })
  }
  edges.sort((a, b) => a.id.localeCompare(b.id))

  const classOf = new Map<string, string[]>()
  for (const node of nodes.values()) {
    const direct = new Set<string>()
    const base = DEFAULT_CLASS_BY_TYPE[node.type]
    if (base !== undefined) direct.add(base)
    for (const e of edges) {
      if (e.retracted === true || e.predicate !== 'instanceOf' || e.from !== node.id) continue
      if (classById.has(e.to)) direct.add(e.to)
    }
    const all = new Set<string>()
    for (const id of direct) {
      all.add(id)
      for (const a of classAncestors(id, classById)) all.add(a)
    }
    classOf.set(node.id, [...all])
  }

  const subclasses = new Map<string, string[]>()
  for (const c of classesFile.classes) {
    for (const a of classAncestors(c.id, classById)) {
      const list = subclasses.get(a) ?? []
      list.push(c.id)
      subclasses.set(a, list)
    }
  }

  const issues: GraphIssue[] = duplicateNodeIds.map((id) => ({
    severity: 'warning',
    code: 'DUP_NODE',
    subject: id,
    message: `节点 ${id} 重复定义，已保留第一次出现的节点`,
  }))

  return {
    nodes,
    edges,
    classOf,
    subclasses,
    classes: classesFile.classes,
    predicates: classesFile.predicates,
    issues,
    builtFrom: src.builtFrom,
  }
}
