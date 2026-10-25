import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import { createProject } from '../storage/project.js'
import { writeSceneFile } from '../storage/scenes.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import {
  acceptScene,
  editSceneSeg,
  listChapterScenes,
  rejectScene,
} from './scene-review-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

/** 造一个场景版本并登记索引 */
async function seedScene(
  chapterNo = 4,
  sceneNo = 1,
  version = 1,
  segs: [string, string][] = [
    ['aaaa', '剑气贴着面颊削过去。'],
    ['bbbb', '她没停。'],
  ],
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
      status: 'candidate',
    })),
  })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-review-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('listChapterScenes', () => {
  it('★ 按 sceneNo + version 聚合，状态取最保守的', async () => {
    await seedScene()
    const rows = await listChapterScenes(4)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe(1)
    expect(rows[0]?.status).toBe('candidate')
    expect(rows[0]?.segCount).toBe(2)
  })

  it('★ 混合状态取 candidate（有未确认的就还没确认完）', async () => {
    await seedScene()
    await db.draftSegment.updateMany({ where: { segId: 'aaaa' }, data: { status: 'accepted' } })
    const rows = await listChapterScenes(4)
    expect(rows[0]?.status).toBe('candidate')
  })

  it('多版本按 sceneNo → version 升序', async () => {
    await seedScene(4, 1, 2)
    await seedScene(4, 1, 1)
    await seedScene(4, 2, 1)
    const rows = await listChapterScenes(4)
    expect(rows.map((r) => `${r.sceneNo}v${r.version}`)).toEqual(['1v1', '1v2', '2v1'])
  })

  it('空章返回空数组', async () => {
    expect(await listChapterScenes(99)).toEqual([])
  })
})

describe('acceptScene', () => {
  it('★ 把该版本全部段标为 accepted 并记录 acceptedAt', async () => {
    await seedScene()
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4, sceneNo: 1 } })
    expect(segs.every((s) => s.status === 'accepted')).toBe(true)
    expect(segs.every((s) => s.acceptedAt !== null)).toBe(true)
  })

  it('★ 接受 v2 时 v1 自动降为 rejected（Ruling 36 互斥）', async () => {
    await seedScene(4, 1, 1)
    await seedScene(4, 1, 2)
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: 2 })
    const v1 = await db.draftSegment.findMany({ where: { filePath: { contains: '.v1.' } } })
    const v2 = await db.draftSegment.findMany({ where: { filePath: { contains: '.v2.' } } })
    expect(v1.every((s) => s.status === 'rejected')).toBe(true)
    expect(v2.every((s) => s.status === 'accepted')).toBe(true)
  })

  it('★ 不写 EntityRevision（正文历史归 Git）', async () => {
    await seedScene()
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    expect(await db.entityRevision.count()).toBe(0)
  })

  it('★ 版本不存在 → NOT_FOUND', async () => {
    await expect(acceptScene({ chapterNo: 4, sceneNo: 1, version: 9 })).rejects.toBeInstanceOf(
      InkloomError,
    )
  })

  it('★ 文件内容不变（accept 只改索引状态 + commit）', async () => {
    await seedScene()
    const p = join(root, 'chapters/ch-004/scenes/s1.v1.md')
    const before = await readFile(p, 'utf8')
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    expect(await readFile(p, 'utf8')).toBe(before)
  })
})

describe('rejectScene', () => {
  it('★ 只改状态，不删文件', async () => {
    await seedScene()
    await rejectScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4, sceneNo: 1 } })
    expect(segs.every((s) => s.status === 'rejected')).toBe(true)
    await expect(
      readFile(join(root, 'chapters/ch-004/scenes/s1.v1.md'), 'utf8'),
    ).resolves.toContain('剑气')
  })

  it('拒绝后可以再接受（状态可逆）', async () => {
    await seedScene()
    await rejectScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: 1 })
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4, sceneNo: 1 } })
    expect(segs.every((s) => s.status === 'accepted')).toBe(true)
  })
})

describe('editSceneSeg', () => {
  it('★ 改一段后产生新版本文件，其他段原样保留', async () => {
    await seedScene()
    const r = await editSceneSeg({
      chapterNo: 4,
      sceneNo: 1,
      version: 1,
      segId: 'bbbb',
      newText: '她没停，也没回头。',
    })
    expect(r.newVersion).toBe(2)
    const raw = await readFile(join(root, r.relPath), 'utf8')
    expect(raw).toContain('她没停，也没回头。')
    expect(raw).toContain('剑气贴着面颊削过去。')
    // ★ segId 不变：段身份是 segId，不是位置
    expect(raw).toContain('<!-- seg:bbbb -->')
    expect(raw).toContain('<!-- seg:aaaa -->')
  })

  it('★ 新段全部 candidate，旧版本段全部 rejected', async () => {
    await seedScene()
    await editSceneSeg({ chapterNo: 4, sceneNo: 1, version: 1, segId: 'bbbb', newText: '改了' })
    const v1 = await db.draftSegment.findMany({ where: { filePath: { contains: '.v1.' } } })
    const v2 = await db.draftSegment.findMany({ where: { filePath: { contains: '.v2.' } } })
    expect(v1.every((s) => s.status === 'rejected')).toBe(true)
    expect(v2.every((s) => s.status === 'candidate')).toBe(true)
    expect(v2).toHaveLength(2)
  })

  it('★ segId 不存在 → NOT_FOUND', async () => {
    await seedScene()
    await expect(
      editSceneSeg({ chapterNo: 4, sceneNo: 1, version: 1, segId: 'zzzz', newText: 'x' }),
    ).rejects.toBeInstanceOf(InkloomError)
  })

  it('★ 空文本被拒绝（不允许把段改空）', async () => {
    await seedScene()
    await expect(
      editSceneSeg({ chapterNo: 4, sceneNo: 1, version: 1, segId: 'bbbb', newText: '   ' }),
    ).rejects.toBeInstanceOf(InkloomError)
  })

  it('编辑保留段序（seq 按文件里的顺序重算）', async () => {
    await seedScene()
    await editSceneSeg({
      chapterNo: 4,
      sceneNo: 1,
      version: 1,
      segId: 'aaaa',
      newText: '开头改了。',
    })
    const v2 = await db.draftSegment.findMany({
      where: { filePath: { contains: '.v2.' } },
      orderBy: { seq: 'asc' },
    })
    expect(v2.map((s) => s.segId)).toEqual(['aaaa', 'bbbb'])
  })

  it('★ 新版本段的 contentHash 是该段自己的（不是整文件）', async () => {
    await seedScene()
    await editSceneSeg({ chapterNo: 4, sceneNo: 1, version: 1, segId: 'bbbb', newText: '改了' })
    const v2 = await db.draftSegment.findMany({ where: { filePath: { contains: '.v2.' } } })
    const aaaa = v2.find((s) => s.segId === 'aaaa')
    const bbbb = v2.find((s) => s.segId === 'bbbb')
    // 未改的段 hash 与改过的段 hash 必须不同
    expect(aaaa?.contentHash).not.toBe(bbbb?.contentHash)
  })
})
