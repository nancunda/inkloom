import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeContext, peekContext } from '../services/context.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject, openProject } from '../storage/project.js'
import { closeBook, openBookAt, switchBook } from './open-book.js'

let libraryRoot: string
let bookA: string
let bookB: string

beforeEach(async () => {
  libraryRoot = await mkdtemp(join(tmpdir(), 'inkloom-open-'))
  const a = await createProject({
    rootPath: join(libraryRoot, '潮骨'),
    name: '潮骨',
    genre: '玄幻',
  })
  const b = await createProject({
    rootPath: join(libraryRoot, '七霞'),
    name: '七霞',
    genre: '玄幻',
  })
  bookA = a.project.rootPath
  bookB = await realpath(join(libraryRoot, '七霞'))
  await openBookAt(bookA)
  void b
})
afterEach(async () => {
  await closeBook().catch(() => undefined)
  await closeContext()
  await rm(libraryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('openBookAt / switchBook', () => {
  it('打开一本书后 current 指向它', async () => {
    expect(peekContext()?.project.name).toBe('潮骨')
    expect(peekContext()?.root).toBe(await realpath(bookA))
  })

  it('★ 同一进程切到另一本书，current 与 project 都变', async () => {
    await switchBook(libraryRoot, '七霞')
    expect(peekContext()?.project.name).toBe('七霞')
    expect(peekContext()?.root).toBe(bookB)
  })

  it('★ 切到索引被删的书会从文件重建', async () => {
    // 先为七霞写一个角色，再删索引；切过去时必须重建出来
    const opened = await openProject(bookB)
    await writeJsonElement(bookB, 'characters/index.json', [
      { id: 'c1', projectId: opened.project.id, name: '林岚', role: 'protagonist' },
    ])
    await rm(join(bookB, '.inkloom', 'index.sqlite'), { force: true })
    await rm(join(bookB, '.inkloom', 'index.sqlite-wal'), { force: true })
    await rm(join(bookB, '.inkloom', 'index.sqlite-shm'), { force: true })

    await switchBook(libraryRoot, '七霞')

    const ctx = peekContext()
    expect(ctx).not.toBeNull()
    expect(await ctx?.db.character.count()).toBe(1)
  })

  it('并发切换被串行化，不抛错且最终落在一本书上', async () => {
    await Promise.all([switchBook(libraryRoot, '七霞'), switchBook(libraryRoot, '潮骨')])
    expect(['潮骨', '七霞']).toContain(peekContext()?.project.name)
  })

  it('关闭书后 current 为空', async () => {
    await closeBook()
    expect(peekContext()).toBeNull()
  })
})
