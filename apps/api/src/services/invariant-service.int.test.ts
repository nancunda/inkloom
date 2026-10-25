import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { listElementRevisions, upsertElement } from './element-service.js'
import {
  assertChapterAppendOnly,
  currentProjectId,
  isSoftDeleted,
  restoreElement,
  softDeleteElement,
} from './invariant-service.js'

let base: string
let root: string
let db: IndexDb
let projectId: string

const REL = 'characters/c1.json'
const CH = { entityType: 'character' as const, entityId: 'c1', relPath: REL }

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-inv-'))
  root = join(base, 'qixia')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  projectId = project.id
  await setContext({ root, db, project })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true })
})

describe('assertChapterAppendOnly（P0-22）', () => {
  async function makeChapter(n: number): Promise<void> {
    await db.blueprint.create({
      data: {
        id: `b${n}`,
        projectId,
        chapterNo: n,
        goal: 'g',
        conflict: 'c',
        hook: 'h',
        castIds: '[]',
      },
    })
  }

  it('空书时可以建第 1 章', async () => {
    await expect(assertChapterAppendOnly(db, projectId, 1)).resolves.toBeUndefined()
  })

  it('追加到末尾允许（max=3，建第 4 章）', async () => {
    for (const n of [1, 2, 3]) await makeChapter(n)
    await expect(assertChapterAppendOnly(db, projectId, 4)).resolves.toBeUndefined()
  })

  it('更新已存在的章允许（max=3，改第 2 章）', async () => {
    for (const n of [1, 2, 3]) await makeChapter(n)
    await expect(assertChapterAppendOnly(db, projectId, 2)).resolves.toBeUndefined()
  })

  it('★ 中间插入被拒绝（已有 1 和 5，建第 3 章）', async () => {
    await makeChapter(1)
    await makeChapter(5)
    try {
      await assertChapterAppendOnly(db, projectId, 3)
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('CONFLICT')
      expect((e as Error).message).toContain('末尾追加')
    }
  })
})

describe('softDeleteElement / restoreElement（P0-11）', () => {
  it('软删除写入 deletedAt，原数据保留', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '林岚' }, changeSource: 'human' })
    const r = await softDeleteElement(CH)
    expect(r.version).toBe(2)
    const raw = await readFile(join(root, REL), 'utf8')
    expect(raw).toContain('deletedAt')
    expect(raw).toContain('林岚')
  })

  it('恢复清除 deletedAt', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '林岚' }, changeSource: 'human' })
    await softDeleteElement(CH)
    const r = await restoreElement(CH)
    expect(r.version).toBe(3)
    expect(await readFile(join(root, REL), 'utf8')).not.toContain('"deletedAt"')
  })

  it('删除与恢复都留痕', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '林岚' }, changeSource: 'human' })
    await softDeleteElement(CH)
    const revs = await listElementRevisions('character', 'c1')
    expect(revs).toHaveLength(2)
    expect(revs[1]?.changeReason).toBe('软删除')
  })

  it('isSoftDeleted 反映当前状态', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '林岚' }, changeSource: 'human' })
    expect(await isSoftDeleted('character', 'c1')).toBe(false)
    await softDeleteElement(CH)
    expect(await isSoftDeleted('character', 'c1')).toBe(true)
    await restoreElement(CH)
    expect(await isSoftDeleted('character', 'c1')).toBe(false)
  })

  it('删除不存在的要素 → NOT_FOUND', async () => {
    try {
      await softDeleteElement({
        entityType: 'character',
        entityId: 'nope',
        relPath: 'characters/nope.json',
      })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('NOT_FOUND')
    }
  })
})

describe('currentProjectId', () => {
  it('返回当前上下文的 projectId', () => {
    expect(currentProjectId()).toBe(projectId)
  })
})
