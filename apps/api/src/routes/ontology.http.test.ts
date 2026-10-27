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
    '{"id":"grp-qingyun","type":"group","name":"青云宗","createdAt":"2026-10-27T00:00:00.000Z"}\n',
    'utf8',
  )
  await writeFile(
    join(dir, 'edges.jsonl'),
    [
      '{"id":"ed-aaaaaa","from":"grp-qingyun","predicate":"instanceOf","to":"cls-sect","source":{"kind":"author"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-bbbbbb","from":"c1","predicate":"belongsTo","to":"grp-qingyun","source":{"kind":"chapter","ref":"ch-007"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-cccccc","from":"c1","predicate":"belongsTo","to":"ghost","source":{"kind":"agent"},"createdAt":"2026-10-27T00:00:00.000Z"}',
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
})
