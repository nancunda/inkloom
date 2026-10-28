import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listSessions,
  readSessionEvents,
  readSessionMeta,
  removeSession,
  renameSession,
  sessionJournalPath,
  writeSessionMeta,
} from './session-store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-sess-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function meta(id: string, title: string) {
  return {
    id,
    title,
    goal: title,
    status: 'done' as const,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    tokens: 0,
    steps: 0,
    subagentCalls: 0,
    planId: null,
    planTitle: null,
    planDone: 0,
    planTotal: 0,
    runIds: [],
    resumable: false,
  }
}

describe('session store', () => {
  it('★ 写入后可读回', async () => {
    await writeSessionMeta(root, meta('cs_a', '第一段'))
    const back = await readSessionMeta(root, 'cs_a')
    expect(back?.title).toBe('第一段')
  })

  it('★ 列表按 updatedAt 倒序', async () => {
    await writeSessionMeta(root, { ...meta('cs_old', '旧'), updatedAt: '2026-10-01T00:00:00.000Z' })
    await writeSessionMeta(root, { ...meta('cs_new', '新'), updatedAt: '2026-10-28T00:00:00.000Z' })
    const list = await listSessions(root)
    expect(list.map((s) => s.id)).toEqual(['cs_new', 'cs_old'])
  })

  it('★ 旧 runs/*.jsonl 补录成 legacy 会话（只读）', async () => {
    const runs = join(root, '.inkloom', 'agent', 'runs')
    await mkdir(runs, { recursive: true })
    await writeFile(
      join(runs, 'ar_legacy1.jsonl'),
      `${JSON.stringify({
        type: 'run.started',
        goal: '旧目标：写一个开头',
        seq: 1,
        at: '2026-10-01T00:00:00.000Z',
      })}\n`,
      'utf8',
    )
    const list = await listSessions(root)
    const legacy = list.find((s) => s.id === 'lg_ar_legacy1')
    expect(legacy?.title).toContain('旧目标')
    expect(legacy?.resumable).toBe(false)
    expect(legacy?.status).toBe('legacy')
  })

  it('★ 回放只读到 limit 条且跳过坏行', async () => {
    const file = sessionJournalPath(root, 'cs_b')
    await mkdir(join(root, '.inkloom', 'agent', 'sessions'), { recursive: true })
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'run.started', goal: 'g', seq: 1, at: '2026-10-28T00:00:00.000Z' }),
        'not json',
        JSON.stringify({ type: 'run.finished', seq: 2, at: '2026-10-28T00:00:01.000Z' }),
      ].join('\n'),
      'utf8',
    )
    const events = await readSessionEvents(root, 'cs_b', 10)
    expect(events).toHaveLength(2)
    expect(await readSessionEvents(root, 'cs_b', 1)).toHaveLength(1)
  })

  it('★ legacy 会话可从旧 journal 回放', async () => {
    const runs = join(root, '.inkloom', 'agent', 'runs')
    await mkdir(runs, { recursive: true })
    await writeFile(
      join(runs, 'ar_old.jsonl'),
      `${JSON.stringify({ type: 'run.started', goal: '旧', seq: 1, at: '2026-10-01T00:00:00.000Z' })}\n`,
      'utf8',
    )
    const events = await readSessionEvents(root, 'lg_ar_old', 10)
    expect(events[0]?.type).toBe('run.started')
  })

  it('★ 运行中的会话不能重命名/删除', async () => {
    await writeSessionMeta(root, { ...meta('cs_run', '运行中'), status: 'running' })
    await expect(renameSession(root, 'cs_run', '新名字')).rejects.toThrow(/运行中/)
    await expect(removeSession(root, 'cs_run')).rejects.toThrow(/运行中/)
  })

  it('★ legacy 会话只读', async () => {
    await expect(renameSession(root, 'lg_ar_x', '新名字')).rejects.toThrow(/只读/)
    await expect(removeSession(root, 'lg_ar_x')).rejects.toThrow(/只读/)
  })

  it('★ 不存在的会话给 NOT_FOUND，空标题给 INVALID_INPUT', async () => {
    await expect(renameSession(root, 'cs_none', 'x')).rejects.toThrow(/不存在/)
    await writeSessionMeta(root, meta('cs_c', '旧名'))
    await expect(renameSession(root, 'cs_c', '   ')).rejects.toThrow(/不能为空/)
  })

  it('★ 带路径分隔符的 id 直接拒绝', async () => {
    await expect(readSessionEvents(root, 'lg_../../evil', 10)).rejects.toThrow(/非法会话 id/)
    await expect(readSessionEvents(root, 'cs_a/b', 10)).rejects.toThrow(/非法会话 id/)
  })

  it('★ 重命名生效；删除会把 meta/journal/快照一起清掉', async () => {
    await writeSessionMeta(root, meta('cs_d', '旧名'))
    const next = await renameSession(root, 'cs_d', '新名')
    expect(next.title).toBe('新名')
    await writeFile(sessionJournalPath(root, 'cs_d'), '{}\n', 'utf8')
    await writeFile(join(root, '.inkloom', 'agent', 'sessions', 'cs_d.messages.json'), '{}', 'utf8')
    await removeSession(root, 'cs_d')
    expect(await readSessionMeta(root, 'cs_d')).toBeNull()
    expect(await readSessionEvents(root, 'cs_d', 10)).toEqual([])
  })
})
