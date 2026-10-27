import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { clearGraphCache, getGraphData } from '../services/ontology-service.js'

export const ontologyRoutes = new Hono()

function limitOf(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def)
  if (!Number.isInteger(n) || n <= 0) return def
  return Math.min(n, max)
}

ontologyRoutes.get('/ontology/graph', async (c) => {
  const { snapshot: snap, warnings } = await getGraphData()
  const classId = c.req.query('class')
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const issuesOnly = c.req.query('issues') === '1'
  const limit = limitOf(c.req.query('limit'), 400, 800)
  const issueSubjects = new Set(snap.issues.map((i) => i.subject))
  // 类 id 也是边的合法端点（instanceOf 指向类），画布上按类名解析
  const classIds = new Set(snap.classes.map((cl) => cl.id))

  // 待修复筛选：问题边的两端也必须在场，否则打开筛选就是一张空画布
  const badEdgeEnds = new Set<string>()
  for (const e of snap.edges) {
    if (!issueSubjects.has(e.id)) continue
    badEdgeEnds.add(e.from)
    badEdgeEnds.add(e.to)
  }

  let nodes = [...snap.nodes.values()]
  if (classId !== undefined && classId.length > 0) {
    nodes = nodes.filter((n) => snap.classOf.get(n.id)?.includes(classId) === true)
  }
  if (q.length > 0) {
    nodes = nodes.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        (n.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    )
  }
  if (issuesOnly) nodes = nodes.filter((n) => issueSubjects.has(n.id) || badEdgeEnds.has(n.id))
  const total = nodes.length
  nodes = nodes.slice(0, limit)

  const visible = new Set([...nodes.map((n) => n.id), ...classIds])
  const edges = snap.edges.filter(
    // 废止记录行只用于吊销，展示上排除；被吊销的边保留（UI 可切换显示）
    (e) => e.tombstone !== true && visible.has(e.from) && visible.has(e.to),
  )
  const builtAt = new Date(snap.builtFrom.mtimeMax || Date.now()).toISOString()

  return c.json({
    nodes: nodes.map((n) => ({ ...n, classIds: snap.classOf.get(n.id) ?? [] })),
    edges,
    classes: snap.classes,
    predicates: snap.predicates,
    issues: snap.issues,
    warnings,
    total,
    truncated: total > nodes.length,
    builtAt,
  })
})

ontologyRoutes.get('/ontology/nodes/:id', async (c) => {
  const { snapshot: snap } = await getGraphData()
  const id = c.req.param('id')
  const node = snap.nodes.get(id)
  if (node === undefined) {
    // 类不是节点，但 instanceOf 边会指向它：给一个可落地的类详情，而不是 404
    const cls = snap.classes.find((cl) => cl.id === id)
    if (cls !== undefined) {
      const instances = [...snap.classOf]
        .filter(([, ids]) => ids.includes(id))
        .map(([nodeId]) => nodeId)
      return c.json({
        node: null,
        class: { ...cls, instanceCount: instances.length },
        instances,
        edges: [],
        issues: snap.issues.filter((i) => i.subject === id),
      })
    }
    throw new InkloomError('NOT_FOUND', `节点 ${id} 不存在`)
  }
  return c.json({
    node: { ...node, classIds: snap.classOf.get(id) ?? [] },
    edges: snap.edges.filter((e) => e.from === id || e.to === id),
    issues: snap.issues.filter((i) => i.subject === id),
  })
})

ontologyRoutes.get('/ontology/classes', async (c) => {
  const { snapshot: snap } = await getGraphData()
  const counts = new Map<string, number>()
  for (const ids of snap.classOf.values()) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return c.json({
    classes: snap.classes.map((cl) => ({ ...cl, instanceCount: counts.get(cl.id) ?? 0 })),
    predicates: snap.predicates,
  })
})

ontologyRoutes.get('/ontology/search', async (c) => {
  const { snapshot: snap } = await getGraphData()
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  if (q.length === 0) return c.json({ nodes: [] })
  const limit = limitOf(c.req.query('limit'), 20, 50)
  const nodes = [...snap.nodes.values()]
    .filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        (n.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    )
    .slice(0, limit)
    .map((n) => ({ ...n, classIds: snap.classOf.get(n.id) ?? [] }))
  return c.json({ nodes })
})

ontologyRoutes.post('/ontology/reload', (c) => {
  clearGraphCache()
  return c.json({ ok: true })
})
