import { explainFact, findPath, matchPattern } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { clearGraphCache, getGraphData } from '../services/ontology-service.js'

export const ontologyRoutes = new Hono()

function limitOf(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def)
  if (!Number.isInteger(n) || n <= 0) return def
  return Math.min(n, max)
}

/** 类闭包计数：父类把子孙实例也算进去（与 /classes 同源） */
function countInstances(classOf: ReadonlyMap<string, string[]>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const ids of classOf.values()) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

ontologyRoutes.get('/ontology/graph', async (c) => {
  const { snapshot: snap, warnings, signature } = await getGraphData()
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
  const counts = countInstances(snap.classOf)

  return c.json({
    nodes: nodes.map((n) => ({ ...n, classIds: snap.classOf.get(n.id) ?? [] })),
    edges,
    classes: snap.classes.map((cl) => ({ ...cl, instanceCount: counts.get(cl.id) ?? 0 })),
    predicates: snap.predicates,
    issues: snap.issues,
    warnings,
    total,
    truncated: total > nodes.length,
    signature,
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
    // 端点名字由服务端给：前端只拿到过滤后的节点集，靠它自己解析会退化成裸 id
    edges: snap.edges
      .filter((e) => e.from === id || e.to === id)
      .filter((e) => e.tombstone !== true)
      .map((e) => ({
        ...e,
        fromName:
          snap.nodes.get(e.from)?.name ??
          snap.classes.find((cl) => cl.id === e.from)?.name ??
          e.from,
        toName:
          snap.nodes.get(e.to)?.name ?? snap.classes.find((cl) => cl.id === e.to)?.name ?? e.to,
      })),
    issues: snap.issues.filter((i) => i.subject === id),
  })
})

ontologyRoutes.get('/ontology/classes', async (c) => {
  const { snapshot: snap } = await getGraphData()
  const counts = countInstances(snap.classOf)
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

/** 查询相关的公共取参：缺参直接 400，避免把 undefined 当成 id 去查 */
function required(raw: string | undefined, key: string): string {
  const v = (raw ?? '').trim()
  if (v.length === 0) throw new InkloomError('INVALID_INPUT', `缺少 ${key}`)
  return v
}

function depthOf(raw: string | undefined): number {
  const t = (raw ?? '').trim()
  if (t.length === 0) return 4
  const n = Number(t)
  // 非整数/非正数回落默认值，与 limitOf 同口径；空值不能当成 0 再 clamp 成 1
  if (!Number.isInteger(n) || n <= 0) return 4
  return Math.min(n, 8)
}

ontologyRoutes.get('/ontology/path', async (c) => {
  const from = required(c.req.query('from'), 'from')
  const to = required(c.req.query('to'), 'to')
  const { snapshot } = await getGraphData()
  return c.json(findPath(snapshot, from, to, depthOf(c.req.query('maxDepth'))))
})

ontologyRoutes.post('/ontology/query', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InkloomError('INVALID_INPUT', '请求体必须是 GraphPattern 对象')
  }
  // ★ attr 是唯一会让 core 抛 TypeError 的字段（Object.entries(null)）：挡成 400，别落成 500
  const pattern = body as Record<string, unknown>
  const attr = pattern['attr']
  if (attr !== undefined) {
    if (attr === null || typeof attr !== 'object' || Array.isArray(attr)) {
      throw new InkloomError('INVALID_INPUT', 'attr 必须是 { 键: 字符串值 } 对象')
    }
    for (const v of Object.values(attr)) {
      if (typeof v !== 'string') throw new InkloomError('INVALID_INPUT', 'attr 的值必须是字符串')
    }
  }
  const { snapshot } = await getGraphData()
  return c.json(matchPattern(snapshot, pattern as Parameters<typeof matchPattern>[1]))
})

ontologyRoutes.get('/ontology/explain', async (c) => {
  const from = required(c.req.query('from'), 'from')
  const predicate = required(c.req.query('predicate'), 'predicate')
  const to = required(c.req.query('to'), 'to')
  const { snapshot } = await getGraphData()
  return c.json(explainFact(snapshot, from, predicate, to))
})
