import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { countWords, serializeChapterFile, splitChapters, splitScenes } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { commitAll, initRepo } from '../git/runner.js'
import { openBookIndexDb } from '../index-db/open-book.js'
import { atomicWrite } from '../storage/atomic-write.js'
import { bookPaths } from '../storage/paths.js'
import { createProject, openProject } from '../storage/project.js'
import { reindex } from '../storage/reindex.js'

export interface ImportChaptersOptions {
  /** 目标书目录：已是 inkloom 书则追加，不存在则新建 */
  rootPath: string
  /** 源文件（.txt / .md），UTF-8 */
  sourcePath: string
  /** 新建书时必填 */
  name?: string
  genre?: string
}

export interface ImportChaptersResult {
  chapters: number
  words: number
  /** 从第几章开始写的（追加时便于核对） */
  startChapterNo: number
  warnings: string[]
}

const pad3 = (n: number): string => String(n).padStart(3, '0')

/** 现有正文的最大章号；没有则 0 */
async function maxChapterNo(chaptersDir: string): Promise<number> {
  const names = await readdir(chaptersDir).catch(() => [] as string[])
  let max = 0
  for (const name of names) {
    const m = /^ch-(\d+)\.md$/.exec(name)
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
  }
  return max
}

/**
 * 把 txt/md 导入成 inkloom 的定稿章节。
 *
 * ★ 写成 `chapters/ch-NNN.md`（定稿正文），不进候选流程：
 *   导入的是用户已经写完的稿子，没有「待确认」这回事。
 *   想改其中某章，走 unfinalize——它会按场景边界反解出场景与段 ID。
 * ★ 章号按出现顺序重排，不沿用原文章号：原稿可能从第 50 章开始、
 *   可能跳号重复，沿用会让后续章节号冲突。
 * ★ 追加模式下从现有最大章号 + 1 开始，不覆盖已有正文。
 */
export async function importChapters(opts: ImportChaptersOptions): Promise<ImportChaptersResult> {
  const root = resolve(opts.rootPath)
  const raw = await readFile(resolve(opts.sourcePath), 'utf8').catch(() => {
    throw new InkloomError('NOT_FOUND', `源文件不存在或不可读：${opts.sourcePath}`)
  })

  const split = splitChapters(raw)
  if (split.chapters.length === 0) {
    throw new InkloomError('INVALID_INPUT', '源文件为空，没有可导入的内容')
  }

  const isBook = existsSync(join(root, 'novel.json'))
  let startNo = 1
  if (isBook) {
    // 校验身份锚：novel.json 在但不是合法书时 openProject 会抛 CONFLICT
    await openProject(root)
    startNo = (await maxChapterNo(bookPaths(root).chapters)) + 1
  } else {
    if (existsSync(root)) {
      const entries = await readdir(root)
      if (entries.length > 0) {
        throw new InkloomError(
          'CONFLICT',
          `目标目录非空且不是 inkloom 书：${root}（换个空目录，或先用 create 建书）`,
        )
      }
    }
    if (opts.name === undefined || opts.genre === undefined) {
      throw new InkloomError('INVALID_INPUT', '新建书籍需要同时提供 name 与 genre')
    }
    await createProject({ rootPath: root, name: opts.name, genre: opts.genre })
  }

  const paths = bookPaths(root)
  await mkdir(paths.chapters, { recursive: true })

  const warnings = [...split.warnings]
  let written = 0
  let words = 0

  for (const [i, ch] of split.chapters.entries()) {
    const chapterNo = startNo + i
    const s = splitScenes(ch.body)
    for (const w of s.warnings) warnings.push(`第 ${chapterNo} 章：${w}`)
    if (s.scenes.length === 0) {
      warnings.push(`第 ${chapterNo} 章正文为空，已跳过（标题：${ch.title}）`)
      continue
    }
    const scenes = s.scenes.map((text, idx) => ({ sceneNo: idx + 1, text }))
    words += scenes.reduce((n, x) => n + countWords(x.text), 0)
    await atomicWrite(
      join(paths.chapters, `ch-${pad3(chapterNo)}.md`),
      serializeChapterFile({ title: ch.title, scenes }),
    )
    written += 1
  }

  await initRepo(root)
  await commitAll(root, `feat(import): 导入 ${written} 章（${basename(opts.sourcePath)}）`)

  const db = await openBookIndexDb(root)
  try {
    await reindex(root, db)
  } finally {
    await db.$disconnect()
  }

  return { chapters: written, words, startChapterNo: startNo, warnings }
}
