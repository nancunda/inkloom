import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { IndexDb } from '../index-db/client.js'
import { clearContext, setContext } from '../services/context.js'
import { clearGraphCache } from '../services/ontology-service.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'

let base = ''
let root = ''
let db: IndexDb
let pid = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-ontology-http-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  clearGraphCache()

  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist', curMental: '戒备' },
    { id: 'c2', projectId: pid, name: '裴无咎', role: 'antagonist' },
  ])
  await writeJsonElement(root, 'characters/relations.json', [
    { id: 'r1', projectId: pid, fromId: 'c1', toId: 'c2', kind: 'enemy', strength: 4 },
  ])
  await writeJsonElement(root, 'world/locations.json', [
    { id: 'l1', projectId: pid, name: '寒山关', type: 'mountain' },
  ])

  const dir = join(root, 'world/ontology')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'classes.json'),
    JSON.stringify({
      version: 1,
      classes: [
        { id: 'cls-character', name: '人物', parentId: null, kind: 'character' },
        { id: 'cls-group', name: '组织', parentId: null, kind: 'group' },
        { id: 'cls-sect', name: '宗门', parentId: 'cls-group', kind: 'group' },
        { id: 'cls-place', name: '地点', parentId: null, kind: 'place' },
      ],
      predicates: [
        { id: 'instanceOf', label: '属于类' },
        { id: 'belongsTo', label: '隶属于' },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(dir, 'nodes.jsonl'),
    [
      '{"id":"grp-qingyun","type":"group","name":"青云宗","createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"grp-hall","type":"group","name":"听雪楼","createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"itm-token","type":"item","name":"玄铁令","createdAt":"2026-10-27T00:00:00.000Z"}',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(dir, 'edges.jsonl'),
    [
      '{"id":"ed-aaaaaa","from":"grp-qingyun","predicate":"instanceOf","to":"cls-sect","source":{"kind":"author"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-bbbbbb","from":"c1","predicate":"belongsTo","to":"grp-qingyun","source":{"kind":"chapter","ref":"ch-007"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-cccccc","from":"c1","predicate":"belongsTo","to":"ghost","source":{"kind":"agent"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      // 一条 2 跳链：验 maxDepth
      '{"id":"ed-dddddd","from":"c2","predicate":"belongsTo","to":"grp-hall","source":{"kind":"author"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-eeeeee","from":"grp-hall","predicate":"belongsTo","to":"itm-token","source":{"kind":"author"},"createdAt":"2026-10-27T00:00:00.000Z"}',
    ].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  clearGraphCache()
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const app = () => createApp()

describe('/api/ontology', () => {
  it('★ 图包含虚拟节点、附加节点与三类边', async () => {
    const r = await app().request('/api/ontology/graph')
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      nodes: { id: string; classIds: string[]; virtual: boolean }[]
      edges: { id: string; virtual: boolean }[]
      issues: { code: string }[]
    }
    const c1 = j.nodes.find((n) => n.id === 'c1')
    expect(c1).toMatchObject({ virtual: true })
    expect(c1?.classIds).toContain('cls-character')
    const grp = j.nodes.find((n) => n.id === 'grp-qingyun')
    expect(grp?.classIds).toEqual(['cls-group', 'cls-sect'])
    expect(j.edges.find((e) => e.id === 'rel-r1')?.virtual).toBe(true)
    expect(j.issues.map((i) => i.code)).toContain('EDGE_ENDPOINT_MISSING')
  })

  it('按类过滤：cls-sect 只含宗门实例', async () => {
    const j = (await (await app().request('/api/ontology/graph?class=cls-sect')).json()) as {
      nodes: { id: string }[]
    }
    expect(j.nodes.map((n) => n.id)).toEqual(['grp-qingyun'])
  })

  it('搜索命中名字与别名；节点详情返回关联边', async () => {
    const s = (await (await app().request('/api/ontology/search?q=青云')).json()) as {
      nodes: { id: string }[]
    }
    expect(s.nodes[0]?.id).toBe('grp-qingyun')

    const d = await app().request('/api/ontology/nodes/grp-qingyun')
    expect(d.status).toBe(200)
    const detail = (await d.json()) as { node: { name: string }; edges: { id: string }[] }
    expect(detail.node.name).toBe('青云宗')
    expect(detail.edges.map((e) => e.id).sort()).toEqual(['ed-aaaaaa', 'ed-bbbbbb'])
  })

  it('不存在的节点 → 404', async () => {
    expect((await app().request('/api/ontology/nodes/nope')).status).toBe(404)
  })

  it('类表带实例计数', async () => {
    const j = (await (await app().request('/api/ontology/classes')).json()) as {
      classes: { id: string; instanceCount: number }[]
    }
    const sect = j.classes.find((c) => c.id === 'cls-sect')
    expect(sect?.instanceCount).toBe(1)
  })

  it('reload 清缓存后仍可读', async () => {
    expect((await app().request('/api/ontology/reload', { method: 'POST' })).status).toBe(200)
    expect((await app().request('/api/ontology/graph')).status).toBe(200)
  })

  it('文件变了缓存自动失效（按 mtime 签名重建）', async () => {
    const first = (await (await app().request('/api/ontology/graph')).json()) as {
      nodes: { id: string }[]
    }
    expect(first.nodes.map((n) => n.id)).not.toContain('grp-later')

    await writeFile(
      join(root, 'world/ontology/nodes.jsonl'),
      [
        '{"id":"grp-qingyun","type":"group","name":"青云宗","createdAt":"2026-10-27T00:00:00.000Z"}',
        '{"id":"grp-later","type":"group","name":"后起宗","createdAt":"2026-10-27T00:00:00.000Z"}',
      ].join('\n'),
      'utf8',
    )
    const second = (await (await app().request('/api/ontology/graph')).json()) as {
      nodes: { id: string }[]
    }
    expect(second.nodes.map((n) => n.id)).toContain('grp-later')
  })

  it('类 id 当端点：返回类详情与实例，而不是 404', async () => {
    const r = await app().request('/api/ontology/nodes/cls-sect')
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      node: null
      class: { id: string; instanceCount: number }
      instances: string[]
    }
    expect(j.node).toBeNull()
    expect(j.class.id).toBe('cls-sect')
    expect(j.instances).toContain('grp-qingyun')
  })

  it('★ 待修复筛选能带出问题边的两端节点', async () => {
    const j = (await (await app().request('/api/ontology/graph?issues=1')).json()) as {
      nodes: { id: string }[]
    }
    // ed-cccccc 的 to 是 ghost，from 是 c1
    expect(j.nodes.map((n) => n.id)).toContain('c1')
  })

  it('节点被 limit 截断时给出 total 与 truncated', async () => {
    const j = (await (await app().request('/api/ontology/graph?limit=1')).json()) as {
      nodes: unknown[]
      total: number
      truncated: boolean
    }
    expect(j.nodes).toHaveLength(1)
    expect(j.total).toBeGreaterThan(1)
    expect(j.truncated).toBe(true)
  })

  it('未打开书时返回 404', async () => {
    clearContext()
    clearGraphCache()
    expect((await app().request('/api/ontology/graph')).status).toBe(404)
  })
})

describe('/api/ontology 查询', () => {
  it('★ 最短路径：c1 → 青云宗（belongsTo）', async () => {
    const r = await app().request('/api/ontology/path?from=c1&to=grp-qingyun')
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      found: boolean
      nodes: { id: string }[]
      edges: { id: string }[]
    }
    expect(j.found).toBe(true)
    expect(j.nodes.map((n) => n.id)).toEqual(['c1', 'grp-qingyun'])
    expect(j.edges.map((e) => e.id)).toEqual(['ed-bbbbbb'])
  })

  it('路径缺参 → 400；找不到 → found=false', async () => {
    expect((await app().request('/api/ontology/path?from=c1')).status).toBe(400)
    const j = (await (await app().request('/api/ontology/path?from=c1&to=nope')).json()) as {
      found: boolean
    }
    expect(j.found).toBe(false)
  })

  it('★ POST /query 按类与谓词查', async () => {
    const byClass = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ classId: 'cls-sect' }),
    })
    expect(byClass.status).toBe(200)
    const j1 = (await byClass.json()) as { nodes: { id: string }[] }
    expect(j1.nodes.map((n) => n.id)).toEqual(['grp-qingyun'])

    const byEdge = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ predicate: 'belongsTo', from: 'c1', to: 'grp-qingyun' }),
    })
    const j2 = (await byEdge.json()) as { nodes: { id: string }[]; edges: { id: string }[] }
    expect(j2.edges.map((e) => e.id)).toEqual(['ed-bbbbbb'])
    expect(j2.nodes.map((n) => n.id).sort()).toEqual(['c1', 'grp-qingyun'])

    // 只给 from：挂在幽灵端点上的边也要返回（契约，不是 bug）
    const byFrom = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ predicate: 'belongsTo', from: 'c1' }),
    })
    const j3 = (await byFrom.json()) as { nodes: { id: string }[]; edges: { id: string }[] }
    expect(j3.edges.map((e) => e.id)).toEqual(['ed-bbbbbb', 'ed-cccccc'])
    expect(j3.nodes.map((n) => n.id).sort()).toEqual(['c1', 'grp-qingyun'])
  })

  it('★ maxDepth：2 跳路径在 1 跳时找不到；空值回落 4；上限 8', async () => {
    const one = await app().request('/api/ontology/path?from=c2&to=itm-token&maxDepth=1')
    expect(((await one.json()) as { found: boolean }).found).toBe(false)

    const def = await app().request('/api/ontology/path?from=c2&to=itm-token')
    expect(((await def.json()) as { found: boolean }).found).toBe(true)

    const high = await app().request('/api/ontology/path?from=c2&to=itm-token&maxDepth=99')
    expect(((await high.json()) as { found: boolean }).found).toBe(true)

    const empty = await app().request('/api/ontology/path?from=c2&to=itm-token&maxDepth=')
    expect(((await empty.json()) as { found: boolean }).found).toBe(true)
  })

  it('query 体不是对象 / 坏了 / attr 为 null → 400', async () => {
    const bad = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify(['x']),
    })
    expect(bad.status).toBe(400)

    const broken = await app().request('/api/ontology/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(broken.status).toBe(400)
    expect(((await broken.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT')

    // ★ attr:null 会让 core 的 Object.entries 抛错：必须挡在 400，不能落成 500
    const nullAttr = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ attr: null }),
    })
    expect(nullAttr.status).toBe(400)

    const numberAttr = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ attr: { tier: 1 } }),
    })
    expect(numberAttr.status).toBe(400)
  })

  it('★ explain：直接边与不存在', async () => {
    const ok = await app().request(
      '/api/ontology/explain?from=c1&predicate=belongsTo&to=grp-qingyun',
    )
    const j = (await ok.json()) as { found: boolean; direct: boolean; reason: string }
    expect(j.found).toBe(true)
    expect(j.direct).toBe(true)
    expect(j.reason).toContain('直接')

    const miss = await app().request('/api/ontology/explain?from=c1&predicate=ally&to=nope')
    const jm = (await miss.json()) as { found: boolean; direct: boolean; via: string[] }
    expect(jm.found).toBe(false)
    expect(jm.direct).toBe(false)
    expect(jm.via).toEqual([])
  })
})
