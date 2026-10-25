import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initRepo } from '../git/runner.js'
import type { IndexDb } from '../index-db/client.js'
import { readJsonElement, writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { createRelation } from './relation-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-rel-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  // 服务的写路径带 commit，测试目录也要是 git 仓库
  await initRepo(root)
  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist' },
    { id: 'c2', projectId: pid, name: '苏婉', role: 'supporting' },
  ])
  await writeJsonElement(root, 'characters/relations.json', [])
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('createRelation（拖线建关系）', () => {
  it('★ 写文件 + 写索引，两处一致', async () => {
    const r = await createRelation({ fromId: 'c1', toId: 'c2', kind: 'ally', strength: 4 })
    expect(r.kind).toBe('ally')

    const file = (await readJsonElement(root, 'characters/relations.json')) as {
      fromId: string
      kind: string
      strength: number
    }[]
    expect(file).toHaveLength(1)
    expect(file[0]).toMatchObject({ fromId: 'c1', toId: 'c2', kind: 'ally', strength: 4 })

    const row = await db.characterRelation.findFirst({ where: { fromId: 'c1' } })
    expect(row?.strength).toBe(4)
  })

  it('★ 重复连线 → CONFLICT（同一对角色同一种关系只算一条）', async () => {
    await createRelation({ fromId: 'c1', toId: 'c2', kind: 'ally' })
    await expect(createRelation({ fromId: 'c1', toId: 'c2', kind: 'ally' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    // 文件里仍然只有一条，没有写半截
    const file = (await readJsonElement(root, 'characters/relations.json')) as unknown[]
    expect(file).toHaveLength(1)
  })

  it('★ 方向不同是两种关系（师徒 A→B ≠ B→A）', async () => {
    await createRelation({ fromId: 'c1', toId: 'c2', kind: 'master' })
    await expect(
      createRelation({ fromId: 'c2', toId: 'c1', kind: 'master' }),
    ).resolves.toMatchObject({ fromId: 'c2' })
  })

  it('角色不存在 → NOT_FOUND', async () => {
    await expect(createRelation({ fromId: 'c1', toId: 'zz', kind: 'ally' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('自己连自己 / 非法类型 / 越界强度 → INVALID_INPUT', async () => {
    await expect(createRelation({ fromId: 'c1', toId: 'c1', kind: 'ally' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(createRelation({ fromId: 'c1', toId: 'c2', kind: 'bogus' })).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    )
    await expect(
      createRelation({ fromId: 'c1', toId: 'c2', kind: 'ally', strength: 9 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
