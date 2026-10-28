import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSessionMeta } from '../agent/session-store.js'
import { createApp } from '../app.js'
import type { IndexDb } from '../index-db/client.js'
import { clearContext, setContext } from '../services/context.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'

let base: string
let root: string
let db: IndexDb | null = null

type App = ReturnType<typeof createApp>

function meta(id: string, title: string) {
  return {
    id,
    title,
    goal: title,
    status: 'done' as const,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    tokens: 10,
    steps: 2,
    subagentCalls: 0,
    planId: null,
    planTitle: null,
    planDone: 0,
    planTotal: 0,
    runIds: [],
    resumable: true,
  }
}

async function app(): Promise<App> {
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  await setContext({ root, db, project })
  return createApp({ apiKey: 'sk-test' })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-sess-http-'))
  root = join(base, 'book')
})

afterEach(async () => {
  clearContext()
  await db?.$disconnect()
  db = null
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  )
})

describe('会话接口', () => {
  it('★ 空库返回空列表', async () => {
    const res = await (await app()).request('/api/agent/sessions')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [] })
  })

  it('★ 列表可见、详情能回放、改名生效', async () => {
    const server = await app()
    await writeSessionMeta(root, meta('cs_abc123', '第一段'))
    const journal = join(root, '.inkloom', 'agent', 'sessions', 'cs_abc123.jsonl')
    await mkdir(join(root, '.inkloom', 'agent', 'sessions'), { recursive: true })
    await writeFile(
      journal,
      `${JSON.stringify({
        type: 'run.started',
        goal: '目标',
        seq: 1,
        at: '2026-10-28T00:00:00.000Z',
        runId: 'ar_x',
      })}\n`,
      'utf8',
    )

    const list = (await (await server.request('/api/agent/sessions')).json()) as {
      sessions: { id: string }[]
    }
    expect(list.sessions.map((s) => s.id)).toEqual(['cs_abc123'])

    const detail = (await (await server.request('/api/agent/sessions/cs_abc123')).json()) as {
      meta: { title: string }
      events: { type: string; runId: string }[]
    }
    expect(detail.meta.title).toBe('第一段')
    expect(detail.events[0]?.type).toBe('run.started')
    expect(detail.events[0]?.runId).toBe('ar_x')

    const renamed = await server.request('/api/agent/sessions/cs_abc123', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '改过的名字' }),
    })
    expect(((await renamed.json()) as { meta: { title: string } }).meta.title).toBe('改过的名字')
  })

  it('★ 删除后详情 404；删不存在也幂等', async () => {
    const server = await app()
    await writeSessionMeta(root, meta('cs_del123', '删我'))
    expect(
      (await server.request('/api/agent/sessions/cs_del123', { method: 'DELETE' })).status,
    ).toBe(200)
    expect((await server.request('/api/agent/sessions/cs_del123')).status).toBe(404)
    expect((await server.request('/api/agent/sessions/cs_none', { method: 'DELETE' })).status).toBe(
      200,
    )
  })

  it('★ 运行中的会话不能删除（409）', async () => {
    const server = await app()
    await writeSessionMeta(root, {
      ...meta('cs_run123', '运行中'),
      status: 'running',
      updatedAt: new Date().toISOString(),
    })
    expect(
      (await server.request('/api/agent/sessions/cs_run123', { method: 'DELETE' })).status,
    ).toBe(409)
  })

  it('★ legacy 会话出现在列表里并能回放（runId 自动补齐）', async () => {
    const server = await app()
    const runs = join(root, '.inkloom', 'agent', 'runs')
    await mkdir(runs, { recursive: true })
    await writeFile(
      join(runs, 'ar_old1.jsonl'),
      `${JSON.stringify({
        type: 'run.started',
        goal: '旧目标',
        seq: 1,
        at: '2026-10-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    )
    const list = (await (await server.request('/api/agent/sessions')).json()) as {
      sessions: { id: string; status: string }[]
    }
    expect(list.sessions[0]?.id).toBe('lg_ar_old1')
    expect(list.sessions[0]?.status).toBe('legacy')

    const detail = (await (await server.request('/api/agent/sessions/lg_ar_old1')).json()) as {
      events: { runId: string }[]
    }
    expect(detail.events[0]?.runId).toBe('ar_old1')
  })

  it('★ legacy 不能改名/续接，缺快照不能续接', async () => {
    const server = await app()
    const rename = await server.request('/api/agent/sessions/lg_ar_x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(rename.status).toBe(409)

    const resume = await server.request('/api/agent/sessions/cs_missing/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '继续' }),
    })
    expect(resume.status).toBe(404)
  })
})
