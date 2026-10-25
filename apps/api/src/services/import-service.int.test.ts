import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openBookIndexDb } from '../index-db/open-book.js'
import { importChapters } from './import-service.js'

let base: string

const SRC = `第一章 入山
他踏上山道，风从袖口灌进来。

第二章 守碑
碑在雾里，字被磨平了。

第三章 剑气
剑气贴着面颊削过去。`

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-import-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('importChapters', () => {
  it('★ 三章 txt → 三个定稿章节文件 + 索引里是 finalized', async () => {
    const src = join(base, 'novel.txt')
    await writeFile(src, SRC, 'utf8')
    const book = join(base, 'book')

    const r = await importChapters({
      rootPath: book,
      sourcePath: src,
      name: '导入书',
      genre: '玄幻',
    })
    expect(r.chapters).toBe(3)
    expect(r.startChapterNo).toBe(1)
    expect(r.words).toBeGreaterThan(0)

    const ch2 = await readFile(join(book, 'chapters', 'ch-002.md'), 'utf8')
    expect(ch2).toContain('# 第二章 守碑')
    expect(ch2).toContain('<!-- scene:1 -->')

    const db = await openBookIndexDb(book)
    try {
      const rows = await db.chapter.findMany({ orderBy: { chapterNo: 'asc' } })
      expect(rows.map((x) => x.chapterNo)).toEqual([1, 2, 3])
      expect(rows.every((x) => x.status === 'finalized')).toBe(true)
      expect(rows[1]?.wordCount).toBeGreaterThan(0)
    } finally {
      await db.$disconnect()
    }
  })

  it('★ 追加：已有 1 章时从第 2 章开始，原章一个字节不动', async () => {
    const src1 = join(base, 'a.txt')
    await writeFile(src1, '第一章 甲\n正文一', 'utf8')
    const book = join(base, 'book')
    await importChapters({ rootPath: book, sourcePath: src1, name: 'X', genre: '玄幻' })
    const before = await readFile(join(book, 'chapters', 'ch-001.md'), 'utf8')

    const src2 = join(base, 'b.txt')
    await writeFile(src2, '第一章 乙\n正文二', 'utf8')
    const r2 = await importChapters({ rootPath: book, sourcePath: src2 })
    expect(r2.startChapterNo).toBe(2)

    expect(await readFile(join(book, 'chapters', 'ch-001.md'), 'utf8')).toBe(before)
    expect(await readFile(join(book, 'chapters', 'ch-002.md'), 'utf8')).toContain('正文二')
  })

  it('目标目录非空且不是 inkloom 书 → CONFLICT（不覆盖别人的文件）', async () => {
    const dir = join(base, 'notabook')
    await mkdir(dir)
    await writeFile(join(dir, 'x.txt'), 'x', 'utf8')
    const src = join(base, 'n.txt')
    await writeFile(src, '正文', 'utf8')
    await expect(
      importChapters({ rootPath: dir, sourcePath: src, name: 'X', genre: '玄幻' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('源文件不存在 → NOT_FOUND', async () => {
    await expect(
      importChapters({
        rootPath: join(base, 'b2'),
        sourcePath: join(base, 'nope.txt'),
        name: 'X',
        genre: '玄幻',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('★ 没有章节标题 → 整本一章 + 告警（不静默丢字）', async () => {
    const src = join(base, 'flat.txt')
    await writeFile(src, '只是一段正文，没有标题。', 'utf8')
    const r = await importChapters({
      rootPath: join(base, 'b3'),
      sourcePath: src,
      name: 'Y',
      genre: '玄幻',
    })
    expect(r.chapters).toBe(1)
    expect(r.warnings.some((w) => w.includes('没有识别到章节标题'))).toBe(true)
  })
})
