import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { writeSceneFile } from '../storage/scenes.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { finalizeChapter, unfinalizeChapter } from './finalize-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

async function seedScene(
  chapterNo: number,
  sceneNo: number,
  version: number,
  segs: [string, string][],
  status: string,
): Promise<void> {
  const { relPath } = await writeSceneFile(
    root,
    { sceneNo, version, segments: segs.map(([segId, text]) => ({ segId, text })) },
    chapterNo,
  )
  await db.draftSegment.createMany({
    data: segs.map(([segId, text], seq) => ({
      id: `seg_${chapterNo}_${sceneNo}_${version}_${segId}`,
      projectId: pid,
      chapterNo,
      sceneNo,
      segId,
      seq,
      filePath: relPath,
      contentHash: 'h',
      wordCount: text.length,
      status,
    })),
  })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-final-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  await writeJsonElement(root, 'story/blueprints/ch-004.json', {
    id: 'b4',
    projectId: pid,
    chapterNo: 4,
    title: '第四章 剑冢',
    goal: '走到碑前',
    conflict: '裴无咎阻拦',
    hook: '碑上的名字是她自己',
    castIds: [],
    beatType: 'climax',
    tensionLevel: 5,
  })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('finalizeChapter', () => {
  it('★ 合并 accepted 场景到 chapters/ch-004.md', async () => {
    await seedScene(4, 1, 1, [['aaaa', '剑气贴着面颊削过去。']], 'accepted')
    await seedScene(4, 2, 1, [['bbbb', '碑上刻着她自己的名字。']], 'accepted')
    const r = await finalizeChapter({ chapterNo: 4, title: '第四章 剑冢' })
    expect(r.sceneCount).toBe(2)
    const raw = await readFile(join(root, r.relPath), 'utf8')
    expect(raw).toContain('剑气贴着面颊削过去')
    expect(raw).toContain('碑上刻着她自己的名字')
    expect(raw).toContain('# 第四章 剑冢')
  })

  it('★ 有 candidate 时拒绝定稿（必须先逐场景确认）', async () => {
    await seedScene(4, 1, 1, [['aaaa', '甲']], 'accepted')
    await seedScene(4, 2, 1, [['bbbb', '乙']], 'candidate')
    await expect(finalizeChapter({ chapterNo: 4 })).rejects.toBeInstanceOf(InkloomError)
  })

  it('★ 没有 accepted 场景时拒绝定稿', async () => {
    await expect(finalizeChapter({ chapterNo: 4 })).rejects.toBeInstanceOf(InkloomError)
  })

  it('★ Chapter 置为 finalized 并写 wordCount', async () => {
    await seedScene(4, 1, 1, [['aaaa', '剑气贴着面颊削过去。']], 'accepted')
    const r = await finalizeChapter({ chapterNo: 4 })
    const ch = await db.chapter.findUnique({
      where: { projectId_chapterNo: { projectId: pid, chapterNo: 4 } },
    })
    expect(ch?.status).toBe('finalized')
    expect(ch?.finalizedAt).not.toBeNull()
    expect(ch?.wordCount).toBe(r.wordCount)
  })

  it('★ 摘要来自蓝图四要素（不调 LLM）', async () => {
    await seedScene(4, 1, 1, [['aaaa', '甲']], 'accepted')
    const r = await finalizeChapter({ chapterNo: 4 })
    expect(r.summary).toContain('走到碑前')
    expect(r.summary).toContain('裴无咎阻拦')
    expect(r.summary).toContain('碑上的名字是她自己')
    const ch = await db.chapter.findUnique({
      where: { projectId_chapterNo: { projectId: pid, chapterNo: 4 } },
    })
    expect(ch?.summaryStale).toBe(false)
    expect(ch?.summaryHash).not.toBeNull()
  })

  it('★ 同场景多版本时只用 accepted 的那版', async () => {
    await seedScene(4, 1, 1, [['aaaa', '旧版本正文']], 'rejected')
    await seedScene(4, 1, 2, [['aaaa', '新版本正文']], 'accepted')
    const r = await finalizeChapter({ chapterNo: 4 })
    const raw = await readFile(join(root, r.relPath), 'utf8')
    expect(raw).toContain('新版本正文')
    expect(raw).not.toContain('旧版本正文')
  })

  it('重复定稿幂等（不会抛错）', async () => {
    await seedScene(4, 1, 1, [['aaaa', '甲']], 'accepted')
    await finalizeChapter({ chapterNo: 4 })
    await expect(finalizeChapter({ chapterNo: 4 })).resolves.toBeDefined()
  })

  it('★ 保留场景边界标记（供撤销时反解）', async () => {
    await seedScene(4, 1, 1, [['aaaa', '甲']], 'accepted')
    await seedScene(4, 2, 1, [['bbbb', '乙']], 'accepted')
    const r = await finalizeChapter({ chapterNo: 4 })
    const raw = await readFile(join(root, r.relPath), 'utf8')
    expect(raw).toContain('<!-- scene:1 -->')
    expect(raw).toContain('<!-- scene:2 -->')
  })
})

describe('unfinalizeChapter', () => {
  it('★ finalized → review，正文文件保留', async () => {
    await seedScene(4, 1, 1, [['aaaa', '甲']], 'accepted')
    const r = await finalizeChapter({ chapterNo: 4 })
    await unfinalizeChapter({ chapterNo: 4 })
    const ch = await db.chapter.findUnique({
      where: { projectId_chapterNo: { projectId: pid, chapterNo: 4 } },
    })
    expect(ch?.status).toBe('review')
    expect(ch?.finalizedAt).toBeNull()
    await expect(readFile(join(root, r.relPath), 'utf8')).resolves.toContain('甲')
  })

  it('★ 不是 finalized 时拒绝撤销', async () => {
    await expect(unfinalizeChapter({ chapterNo: 4 })).rejects.toBeInstanceOf(InkloomError)
  })
})
