import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import type { IndexDb } from './client.js'

let dir: string
let db: IndexDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkloom-db-'))
  db = await freshIndexDb(dir)
})

afterEach(async () => {
  await db.$disconnect()
  await rm(dir, { recursive: true, force: true })
})

describe('索引数据库', () => {
  it('19 张业务表全部存在', async () => {
    const rows = await db.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'
    `
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(
      [
        'Asset',
        'Blueprint',
        'Chapter',
        'Character',
        'CharacterRelation',
        'CharacterSignature',
        'DraftSegment',
        'EntityRevision',
        'GenerationRun',
        'Location',
        'LoreReference',
        'ModelProfile',
        'PlotThread',
        'PowerSystem',
        'PowerTier',
        'Project',
        'ProjectSetting',
        'PromptTemplate',
        'QualityReview',
        'Route',
        'ScenePlan',
        'StoryArc',
        'StyleAsset',
        'WritingTechnique',
        'WorldRule',
      ].sort(),
    )
  })

  it('WAL 模式已开启', async () => {
    const r = await db.$queryRaw<{ journal_mode: string }[]>`PRAGMA journal_mode`
    expect(r[0]?.journal_mode).toBe('wal')
  })

  it('EntityRevision 的 (entityType, entityId, version) 唯一约束生效', async () => {
    await db.project.create({
      data: { id: 'p1', folderId: 'f1', rootPath: '/x', name: 'X', genre: '玄幻' },
    })
    const base = {
      id: 'r1',
      projectId: 'p1',
      entityType: 'character',
      entityId: 'c1',
      version: 1,
      payload: '{}',
      changeSource: 'human',
    }
    await db.entityRevision.create({ data: base })
    await expect(db.entityRevision.create({ data: { ...base, id: 'r2' } })).rejects.toThrow()
  })

  it('DraftSegment 的 (projectId, segId) 唯一约束生效', async () => {
    await db.project.create({
      data: { id: 'p1', folderId: 'f1', rootPath: '/x', name: 'X', genre: '玄幻' },
    })
    const base = {
      id: 's1',
      projectId: 'p1',
      chapterNo: 1,
      sceneNo: 1,
      segId: 'aaaa',
      seq: 0,
      filePath: 'chapters/ch-001/scenes/s1.v1.md',
      contentHash: 'h',
      status: 'candidate',
    }
    await db.draftSegment.create({ data: base })
    await expect(db.draftSegment.create({ data: { ...base, id: 's2' } })).rejects.toThrow()
  })

  it('Blueprint 的 (projectId, chapterNo) 唯一约束生效', async () => {
    await db.project.create({
      data: { id: 'p1', folderId: 'f1', rootPath: '/x', name: 'X', genre: '玄幻' },
    })
    const base = {
      id: 'b1',
      projectId: 'p1',
      chapterNo: 1,
      goal: 'g',
      conflict: 'c',
      hook: 'h',
      castIds: '[]',
    }
    await db.blueprint.create({ data: base })
    await expect(db.blueprint.create({ data: { ...base, id: 'b2' } })).rejects.toThrow()
  })

  it('PlotThread.title 字段存在（不是 name）', async () => {
    await db.project.create({
      data: { id: 'p1', folderId: 'f1', rootPath: '/x', name: 'X', genre: '玄幻' },
    })
    const t = await db.plotThread.create({
      data: {
        id: 't1',
        projectId: 'p1',
        kind: 'foreshadow',
        title: '碑上的名字',
        advancedChapters: '[]',
      },
    })
    expect(t.title).toBe('碑上的名字')
    expect(t.plantedChapter).toBeNull()
  })
})
