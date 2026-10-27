import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearContext, setContext } from '../services/context.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { getLoreForRun, savePage, saveSearchHits } from './lore-service.js'

async function freshDb(): Promise<{
  db: Awaited<ReturnType<typeof freshIndexDb>>
  projectId: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'inkloom-lore-'))
  const db = await freshIndexDb(dir)
  const root = join(dir, 'book')
  const { project } = await createProject({ rootPath: root, name: '测试书', genre: '玄幻' })
  // ★ setContext 会把 Project 行 upsert 进索引库；没有它，LoreReference 的外键会失败
  await setContext({ root, db, project })
  return { db, projectId: project.id }
}

describe('lore service', () => {
  it('搜索结果落卡，带 provider 与 runId，默认未批准', async () => {
    const { db, projectId } = await freshDb()
    try {
      const ids = await saveSearchHits(db, projectId, 'ar_1', '剑冢 设定', [
        { title: '剑冢', url: 'https://a.example', snippet: '摘要', provider: 'tavily' },
      ])
      expect(ids).toHaveLength(1)
      const first = ids[0]
      if (first === undefined) throw new Error('没有落卡')
      const row = await db.loreReference.findUnique({ where: { id: first.id } })
      expect(row?.provider).toBe('tavily')
      expect(row?.approved).toBe(false)
      expect(row?.usedInRunIds).toContain('ar_1')
    } finally {
      clearContext()
      await db.$disconnect()
    }
  })

  it('★ 本 run 的卡可读；别的 run 未批准不可读', async () => {
    const { db, projectId } = await freshDb()
    try {
      const saved = await saveSearchHits(db, projectId, 'ar_1', 'q', [
        { title: 'T', url: 'https://a.example', snippet: 'S', provider: 'searxng' },
      ])
      const id = saved[0]?.id
      if (id === undefined) throw new Error('没有落卡')
      expect((await getLoreForRun(db, id, 'ar_1'))?.title).toBe('T')
      expect(await getLoreForRun(db, id, 'ar_2')).toBeNull()
    } finally {
      clearContext()
      await db.$disconnect()
    }
  })

  it('read_url 的正文进 content', async () => {
    const { db, projectId } = await freshDb()
    try {
      const { id } = await savePage(db, projectId, 'ar_1', {
        title: '页面',
        url: 'https://b.example',
        text: '正文正文',
        extracted: true,
      })
      const row = await db.loreReference.findUnique({ where: { id } })
      expect(row?.content).toBe('正文正文')
      expect(row?.provider).toBe('url')
    } finally {
      clearContext()
      await db.$disconnect()
    }
  })
})
