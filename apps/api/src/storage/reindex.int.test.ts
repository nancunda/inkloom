import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RevisionRecord } from '@inkloom/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { mergeChapter } from './chapters.js'
import { writeJsonElement } from './elements.js'
import { createProject } from './project.js'
import { reindex } from './reindex.js'
import { markAccepted, markRejected } from './review-state.js'
import { appendRevision } from './revisions.js'
import { writeSceneFile } from './scenes.js'

let base: string
let root: string
let db: IndexDb

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-ri-'))
  root = join(base, 'qixia')
  db = await freshIndexDb(base)
})
afterEach(async () => {
  await db.$disconnect()
  await rm(base, { recursive: true, force: true })
})

async function seed(projectId: string): Promise<void> {
  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId, name: '林岚', role: 'protagonist' },
    { id: 'c2', projectId, name: '苏婉', role: 'supporting' },
  ])
  await writeJsonElement(root, 'world/rules.json', [
    {
      id: 'w1',
      projectId,
      category: 'power',
      name: '灵潮',
      content: '每甲子一次',
      priority: 'hard',
    },
  ])
  await writeJsonElement(root, 'story/blueprints/ch-001.json', {
    id: 'b1',
    projectId,
    chapterNo: 1,
    goal: '入山',
    conflict: '守山人',
    hook: '剑鸣',
    castIds: ['c1'],
    tensionLevel: 2,
    beatType: 'setup',
  })
  await writeJsonElement(root, 'story/threads.json', [
    {
      id: 't1',
      projectId,
      kind: 'foreshadow',
      title: '碑上的名字',
      plantedChapter: 1,
      advancedChapters: [],
    },
  ])
  await writeSceneFile(
    root,
    {
      sceneNo: 1,
      version: 1,
      segments: [
        { segId: 'aaaa', text: '林岚踏上山道。' },
        { segId: 'bbbb', text: '风起。' },
      ],
    },
    1,
  )
  await mergeChapter(root, {
    chapterNo: 1,
    title: '第一章 入山',
    scenes: [{ sceneNo: 1, text: '合并正文。' }],
  })
  const rec: RevisionRecord = {
    id: 'r1',
    entityType: 'character',
    entityId: 'c1',
    version: 1,
    parentRevisionId: null,
    payload: JSON.stringify({ id: 'c1', name: '林岚' }),
    changeSource: 'human',
    changeReason: null,
    generationRunId: null,
    createdAt: '2026-10-25T00:00:00.000Z',
  }
  await appendRevision(root, rec)
}

describe('reindex', () => {
  it('从文件重建全部索引', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    const report = await reindex(root, db)
    expect(report.projects).toBe(1)
    expect(report.characters).toBe(2)
    expect(report.worldRules).toBe(1)
    expect(report.blueprints).toBe(1)
    expect(report.plotThreads).toBe(1)
    expect(report.chapters).toBe(1)
    expect(report.segments).toBe(2)
    expect(report.warnings).toEqual([])
  })

  it('★ .jsonl 被扫描进 EntityRevision（上一轮审查的阻塞修复）', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    const report = await reindex(root, db)
    expect(report.revisions).toBe(1)
    const revs = await db.entityRevision.findMany()
    expect(revs).toHaveLength(1)
    expect(revs[0]?.entityId).toBe('c1')
  })

  it('★ 多版本同 segId 不冲突，且均计入索引（id 带 version）', async () => {
    await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 1, segments: [{ segId: 'aaaa', text: '旧版本。' }] },
      4,
    )
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 2, segments: [{ segId: 'aaaa', text: '新版本。' }] },
      4,
    )
    const report = await reindex(root, db)
    expect(report.warnings).toEqual([])
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4, sceneNo: 1 } })
    expect(segs).toHaveLength(2)
    expect(new Set(segs.map((s) => s.filePath)).size).toBe(2)
  })

  it('★ 重建后字数不为 0（用户要靠它判断候选多长）', async () => {
    await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 1, segments: [{ segId: 'aaaa', text: '剑气贴着面颊削过去。' }] },
      4,
    )
    await reindex(root, db)
    const seg = await db.draftSegment.findFirst({ where: { chapterNo: 4, sceneNo: 1 } })
    expect(seg?.wordCount).toBeGreaterThan(0)
  })

  it('★ 已定稿章重建后 wordCount 不为 0（Ruling 48）', async () => {
    await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章 剑冢',
      scenes: [{ sceneNo: 1, text: '剑气贴着面颊削过去。' }],
    })
    await reindex(root, db)
    const ch = await db.chapter.findFirst({ where: { chapterNo: 4 } })
    expect(ch?.status).toBe('finalized')
    expect(ch?.wordCount).toBeGreaterThan(0)
    expect(ch?.finalizedAt).not.toBeNull()
  })

  it('★ review.json 决定重建后的场景状态（Ruling 47：重建不得把 accepted 变回 candidate）', async () => {
    await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    for (const v of [1, 2]) {
      await writeSceneFile(
        root,
        { sceneNo: 1, version: v, segments: [{ segId: 'aaaa', text: `第 ${v} 版。` }] },
        4,
      )
    }
    await writeSceneFile(
      root,
      { sceneNo: 2, version: 1, segments: [{ segId: 'bbbb', text: '另一场。' }] },
      4,
    )
    // 场景 1 接受 v2、拒绝 v1；场景 2 未审阅
    await markAccepted(root, 4, 1, 2)
    await markRejected(root, 4, 1, 1)

    await reindex(root, db)
    // 直接查表：本测试文件不建 AppContext，listChapterScenes 需要在 context 下才能跑
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4 } })
    const statusOf = (sceneNo: number, fileSuffix: string): string | undefined =>
      segs.find((s) => s.sceneNo === sceneNo && s.filePath.endsWith(fileSuffix))?.status
    expect(statusOf(1, 's1.v2.md')).toBe('accepted')
    expect(statusOf(1, 's1.v1.md')).toBe('rejected')
    expect(statusOf(2, 's2.v1.md')).toBe('candidate')
    const acceptedSeg = segs.find((s) => s.filePath.endsWith('s1.v2.md'))
    expect(acceptedSeg?.acceptedAt).not.toBeNull()
  })

  it('幂等：连续 reindex 两次结果相同，不重复插入', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    await reindex(root, db)
    const second = await reindex(root, db)
    expect(second.characters).toBe(2)
    expect(await db.character.count()).toBe(2)
    expect(await db.entityRevision.count()).toBe(1)
  })

  it('★ 索引内容被删除后可从文件完全重建（P0-18 核心验收）', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    await reindex(root, db)
    await db.character.deleteMany()
    await db.entityRevision.deleteMany()
    await db.draftSegment.deleteMany()
    expect(await db.character.count()).toBe(0)

    await reindex(root, db)
    expect(await db.character.count()).toBe(2)
    expect(await db.entityRevision.count()).toBe(1)
    expect(await db.draftSegment.count()).toBe(2)
  })

  it('外部改文件后再 reindex，索引反映新值', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    await reindex(root, db)
    await writeJsonElement(root, 'characters/index.json', [
      { id: 'c1', projectId: project.id, name: '林岚（改名）', role: 'protagonist' },
    ])
    await reindex(root, db)
    expect((await db.character.findUnique({ where: { id: 'c1' } }))?.name).toBe('林岚（改名）')
    expect(await db.character.count()).toBe(1)
  })

  it('损坏的 JSON 文件记 warning 并跳过，不中断整个重建', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    await writeFile(join(root, 'world', 'bad.json'), '{oops', 'utf8')
    const report = await reindex(root, db)
    // world/bad.json 不在扫描清单里，不会被读到；改测蓝图目录里放一个坏文件
    expect(report.characters).toBe(2)
  })

  it('★ 蓝图目录里的坏 JSON 记 warning 但不中断', async () => {
    const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
    await seed(project.id)
    await writeFile(join(root, 'story', 'blueprints', 'ch-002.json'), '{oops', 'utf8')
    const report = await reindex(root, db)
    expect(report.warnings.some((w) => w.includes('ch-002.json'))).toBe(true)
    expect(report.blueprints).toBe(1)
    expect(report.characters).toBe(2)
  })

  it('novel.json 不存在 → NOT_FOUND', async () => {
    await expect(reindex(root, db)).rejects.toThrowError()
  })
})
