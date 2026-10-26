import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject } from '../storage/project.js'
import { createLibraryBook, listBooks, resolveBookDir, sanitizeFolder } from './library.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-lib-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeBook(folder: string, name: string): Promise<void> {
  await createProject({ rootPath: join(root, folder), name, genre: '玄幻', totalChapters: 5 })
}

describe('sanitizeFolder', () => {
  it('保留中文书名，并去掉 Windows 非法字符', () => {
    expect(sanitizeFolder('潮骨')).toBe('潮骨')
    expect(sanitizeFolder('七霞/上卷')).toBe('七霞上卷')
    expect(sanitizeFolder('a:b*c?')).toBe('abc')
  })

  it('空名与保留名有兜底', () => {
    expect(sanitizeFolder('   ')).toBe('book')
    expect(sanitizeFolder('CON')).toBe('CON-book')
    expect(sanitizeFolder('名字.')).toBe('名字')
  })
})

describe('resolveBookDir', () => {
  it('★ 只接受库内一级目录，拒绝穿逗', async () => {
    await mkdir(join(root, 'book-a'))
    await expect(resolveBookDir(root, '..')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(resolveBookDir(root, 'a/b')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(resolveBookDir(root, '..\\x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(resolveBookDir(root, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('合法目录返回 realpath', async () => {
    await mkdir(join(root, 'book-a'))
    const dir = await resolveBookDir(root, 'book-a')
    expect(dir).toBe(await realpath(join(root, 'book-a')))
  })
})

describe('listBooks / createLibraryBook', () => {
  it('扫描一级目录，只识别有 project-id + novel.json 的书', async () => {
    await makeBook('潮骨', '潮骨')
    await makeBook('七霞', '七霞')
    await mkdir(join(root, 'not-a-book'))

    const books = await listBooks(root)

    expect(books.map((b) => b.folder).sort()).toEqual(['七霞', '潮骨'].sort())
    expect(books.find((b) => b.folder === '潮骨')?.name).toBe('潮骨')
  })

  it('★ 中文书名直接建目录（不依赖 ASCII slug）', async () => {
    const created = await createLibraryBook(root, { name: '潮骨', genre: '玄幻' })
    expect(created.folder).toBe('潮骨')
    expect(created.name).toBe('潮骨')
    const books = await listBooks(root)
    expect(books).toHaveLength(1)
  })

  it('重名时加 -2，不覆盖已有书', async () => {
    const first = await createLibraryBook(root, { name: '潮骨', genre: '玄幻' })
    const second = await createLibraryBook(root, { name: '潮骨', genre: '玄幻' })
    expect(first.folder).toBe('潮骨')
    expect(second.folder).toBe('潮骨-2')
  })
})
