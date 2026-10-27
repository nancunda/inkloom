import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { clearGraphCache, getGraphSnapshot } from '../services/ontology-service.js'

export const ontologyRoutes = new Hono()

function limitOf(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def)
  if (!Number.isInteger(n) || n <= 0) return def
  return Math.min(n, max)
}

ontologyRoutes.get('/ontology/graph', async (c) => {
  const snap = await getGraphSnapshot()
  const classId = c.req.query('class')
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const issuesOnly = c.req.query('issues') === '1'
  const limit = limitOf(c.req.query('limit'), 400, 800)
  const issueSubjects = new Set(snap.issues.map((i) => i.subject))

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
  if (issuesOnly) nodes = nodes.filter((n) => issueSubjects.has(n.id))
  nodes = nodes.slice(0, limit)

  const ids = new Set(nodes.map((n) => n.id))
  const edges = snap.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const builtAt = new Date(snap.builtFrom.mtimeMax || Date.now()).toISOString()

  return c.json({
    nodes: nodes.map((n) => ({ ...n, classIds: snap.classOf.get(n.id) ?? [] })),
    edges,
    classes: snap.classes,
    predicates: snap.predicates,
    issues: snap.issues,
    builtAt,
  })
})

ontologyRoutes.get('/ontology/nodes/:id', async (c) => {
  const snap = await getGraphSnapshot()
  const id = c.req.param('id')
  const node = snap.nodes.get(id)
  if (node === undefined) throw new InkloomError('NOT_FOUND', `节点 ${id} 不存在`)
  return c.json({
    node: { ...node, classIds: snap.classOf.get(id) ?? [] },
    edges: snap.edges.filter((e) => e.from === id || e.to === id),
    issues: snap.issues.filter((i) => i.subject === id),
  })
})

ontologyRoutes.get('/ontology/classes', async (c) => {
  const snap = await getGraphSnapshot()
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
  const snap = await getGraphSnapshot()
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
  return c.json({ nodes })
})

ontologyRoutes.post('/ontology/reload', (c) => {
  clearGraphCache()
  return c.json({ ok: true })
})
