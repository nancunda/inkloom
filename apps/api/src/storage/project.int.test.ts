import { mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, openProject, readProjectId } from './project.js'

let base: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-proj-'))
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const root = (): string => join(base, 'qixia')

describe('createProject', () => {
  it('建出完整目录树', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    const entries = await readdir(root())
    for (const e of [
      'novel.json',
      'world',
      'characters',
      'story',
      'chapters',
      'styles',
      'assets',
      '.inkloom',
      'README.md',
    ]) {
      expect(entries).toContain(e)
    }
  })

  it('novel.json 内容与入参一致，且带 folderId', async () => {
    const { project } = await createProject({
      rootPath: root(),
      name: '七霞',
      genre: '玄幻',
      totalChapters: 300,
      coreIdea: '剑冢里的名字',
    })
    expect(project.name).toBe('七霞')
    expect(project.totalChapters).toBe(300)
    expect(project.coreIdea).toBe('剑冢里的名字')
    expect(project.folderId).toMatch(/^[0-9a-f]+$/)
    expect(project.status).toBe('draft')
  })

  it('project-id 与 novel.json 的 folderId 一致', async () => {
    const { project } = await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    expect(await readProjectId(root())).toBe(project.folderId)
  })

  it('★ 重复建书 → CONFLICT（不会覆盖已有数据）', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    try {
      await createProject({ rootPath: root(), name: '改个名', genre: '玄幻' })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('CONFLICT')
    }
  })

  it('父目录不存在也能建', async () => {
    const deep = join(base, 'a', 'b', 'c')
    await createProject({ rootPath: deep, name: '深层', genre: '玄幻' })
    expect((await stat(deep)).isDirectory()).toBe(true)
  })

  it('建出空的要素容器文件（避免后续读到 undefined）', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    const chars = await readdir(join(root(), 'characters'))
    expect(chars).toContain('index.json')
    expect(chars).toContain('relations.json')
    expect(chars).toContain('signatures.json')
    const world = await readdir(join(root(), 'world'))
    expect(world).toContain('rules.json')
    expect(world).toContain('routes.json')
  })

  it('★ 建出默认文风（isDefault=true），否则装配时不知道用哪套', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    const styles = await readdir(join(root(), 'styles'))
    expect(styles).toContain('default.json')
    const { readJsonElement } = await import('./elements.js')
    const style = (await readJsonElement(root(), 'styles/default.json')) as { isDefault: boolean }
    expect(style.isDefault).toBe(true)
  })

  it('README 说明目录职责（用户直接打开也能懂）', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    const { readFile } = await import('node:fs/promises')
    const readme = await readFile(join(root(), 'README.md'), 'utf8')
    expect(readme).toContain('chapters/')
    expect(readme).toContain('reindex')
  })
})

describe('openProject', () => {
  it('能读回建好的书', async () => {
    const created = await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    const opened = await openProject(root())
    expect(opened.project.id).toBe(created.project.id)
    expect(opened.folderId).toBe(created.project.folderId)
  })

  it('目录不存在 → NOT_FOUND', async () => {
    try {
      await openProject(join(base, 'nope'))
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('NOT_FOUND')
    }
  })

  it('缺 project-id → NOT_FOUND，且提示不是 inkloom 书', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    await unlink(join(root(), '.inkloom', 'project-id'))
    try {
      await openProject(root())
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('NOT_FOUND')
      expect((e as Error).message).toContain('inkloom')
    }
  })

  it('★ project-id 与 novel.json 的 folderId 不一致 → CONFLICT（防止认错书）', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    await writeFile(join(root(), '.inkloom', 'project-id'), 'deadbeef', 'utf8')
    try {
      await openProject(root())
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('CONFLICT')
    }
  })

  it('novel.json 损坏 → INVALID_INPUT', async () => {
    await createProject({ rootPath: root(), name: '七霞', genre: '玄幻' })
    await writeFile(join(root(), 'novel.json'), '{oops', 'utf8')
    try {
      await openProject(root())
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('INVALID_INPUT')
    }
  })
})
