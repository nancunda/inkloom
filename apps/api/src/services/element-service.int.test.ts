import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git } from '../git/runner.js'
import type { IndexDb } from '../index-db/client.js'
import { createProject } from '../storage/project.js'
import { readRevisions } from '../storage/revisions.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, getContext, setContext } from './context.js'
import {
  listElementRevisions,
  readElement,
  rollbackElement,
  upsertElement,
} from './element-service.js'

let base: string
let root: string
let db: IndexDb

const CH = { entityType: 'character' as const, entityId: 'c1', relPath: 'characters/c1.json' }

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-svc-'))
  root = join(base, 'qixia')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  await setContext({ root, db, project })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true })
})

describe('upsertElement（spec §2.6 写入顺序）', () => {
  it('首次写入 version=1：文件落盘 + 索引更新 + git commit', async () => {
    const r = await upsertElement({
      ...CH,
      payload: { id: 'c1', name: '林岚', role: 'protagonist' },
      changeSource: 'human',
    })
    expect(r.version).toBe(1)

    // 文件
    const raw = await readFile(join(root, CH.relPath), 'utf8')
    expect(raw).toContain('林岚')
    // 索引（syncElement 立即生效，不需 reindex）
    const c = await db.character.findUnique({ where: { id: 'c1' } })
    expect(c?.name).toBe('林岚')
    // git
    const count = await git(root, ['rev-list', '--count', 'HEAD'])
    expect(Number(count.trim())).toBeGreaterThanOrEqual(1)
  })

  it('第二次写入 version=2，parent 指向前一条', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'A' }, changeSource: 'human' })
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'B' }, changeSource: 'human' })
    const revs = await listElementRevisions('character', 'c1')
    expect(revs).toHaveLength(2)
    expect(revs[1]?.version).toBe(2)
    expect(revs[1]?.parentRevisionId).toBe(revs[0]?.id)
  })

  it('★ 历史追加到 JSONL（不是数据库）；索引清空后历史仍在', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'A' }, changeSource: 'human' })
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'B' }, changeSource: 'human' })
    // 清空索引表的修订记录
    await db.entityRevision.deleteMany()
    expect(await db.entityRevision.count()).toBe(0)
    // 历史在文件里，一个字节没丢
    const onDisk = await readRevisions(root, 'character', 'c1')
    expect(onDisk).toHaveLength(2)
    expect(onDisk[1]?.version).toBe(2)
  })

  it('★ 外部改文件后写入 → CAS_MISMATCH，且不覆盖用户改动', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'A' }, changeSource: 'human' })
    await writeFile(join(root, CH.relPath), '{"id":"c1","name":"用户在 VSCode 改的"}', 'utf8')
    try {
      await upsertElement({ ...CH, payload: { id: 'c1', name: 'B' }, changeSource: 'human' })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('CAS_MISMATCH')
    }
    expect(await readFile(join(root, CH.relPath), 'utf8')).toContain('VSCode')
    // 历史不能多出一条（CAS 失败时历史与索引都没动）
    expect(await listElementRevisions('character', 'c1')).toHaveLength(1)
  })

  it('changeReason 被记录', async () => {
    await upsertElement({
      ...CH,
      payload: { id: 'c1', name: 'A' },
      changeSource: 'human',
      changeReason: '改名',
    })
    expect((await listElementRevisions('character', 'c1'))[0]?.changeReason).toBe('改名')
  })

  it('未打开书时抛 NOT_FOUND', async () => {
    clearContext()
    await expect(
      upsertElement({ ...CH, payload: { id: 'c1' }, changeSource: 'human' }),
    ).rejects.toThrowError(InkloomError)
  })
})

describe('rollbackElement（P0-10 要素回退）', () => {
  it('★ 回退到 v1 → 产生 v3（回退本身是新版本，不改历史）', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '原始' }, changeSource: 'human' })
    await upsertElement({ ...CH, payload: { id: 'c1', name: '改坏' }, changeSource: 'human' })
    const r = await rollbackElement({ ...CH, toVersion: 1 })
    expect(r.version).toBe(3)
    const revs = await listElementRevisions('character', 'c1')
    expect(revs).toHaveLength(3)
    expect(revs[2]?.changeSource).toBe('rollback')
    expect(JSON.parse(revs[2]?.payload ?? '{}')).toEqual({ id: 'c1', name: '原始' })
  })

  it('文件内容也回到 v1 的值', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '原始' }, changeSource: 'human' })
    await upsertElement({ ...CH, payload: { id: 'c1', name: '改坏' }, changeSource: 'human' })
    await rollbackElement({ ...CH, toVersion: 1 })
    expect(await readFile(join(root, CH.relPath), 'utf8')).toContain('原始')
    expect((await db.character.findUnique({ where: { id: 'c1' } }))?.name).toBe('原始')
  })

  it('目标版本不存在 → NOT_FOUND', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'A' }, changeSource: 'human' })
    try {
      await rollbackElement({ ...CH, toVersion: 9 })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('NOT_FOUND')
    }
  })

  it('回退也可再回退（历史是完整的链）', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'V1' }, changeSource: 'human' })
    await upsertElement({ ...CH, payload: { id: 'c1', name: 'V2' }, changeSource: 'human' })
    await rollbackElement({ ...CH, toVersion: 1 }) // v3 = V1
    await rollbackElement({ ...CH, toVersion: 2 }) // v4 = V2
    const revs = await listElementRevisions('character', 'c1')
    expect(revs).toHaveLength(4)
    expect(JSON.parse(revs[3]?.payload ?? '{}')).toEqual({ id: 'c1', name: 'V2' })
  })
})

describe('readElement', () => {
  it('读文件当前值（不是索引）', async () => {
    await upsertElement({ ...CH, payload: { id: 'c1', name: '林岚' }, changeSource: 'human' })
    expect(await readElement(CH.relPath)).toEqual({ id: 'c1', name: '林岚' })
  })

  it('不存在返回 null', async () => {
    expect(await readElement('characters/nope.json')).toBeNull()
  })
})

describe('context', () => {
  it('未打开书时 getContext 抛 NOT_FOUND', () => {
    clearContext()
    expect(() => getContext()).toThrowError(InkloomError)
  })
})
