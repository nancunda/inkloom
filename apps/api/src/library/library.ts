import type { Dirent } from 'node:fs'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { atomicWrite, readIfExists } from '../storage/atomic-write.js'
import { createProject } from '../storage/project.js'

/**
 * 书库：一个普通文件夹，一级子目录 = 一本书。
 *
 * ★ 书本身仍然是「一个文件夹 = 一本书」（可整个拷走）；
 *   书库只解决「怎么在多本书之间切」。
 * ★ 第一版只允许打开库内一级目录，不接受任意路径：
 *   否则一个 API 请求就能读写磁盘任意位置。
 */
export interface LibraryBook {
  /** 库内目录名（打开时用它，不传绝对路径） */
  folder: string
  rootPath: string
  name: string
  genre: string
  totalChapters: number | null
  updatedAt: string
}

export interface CreateBookInput {
  name: string
  genre: string
  totalChapters?: number
  wordsPerChapter?: number
}

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

export function resolveLibraryRoot(): string {
  const fromEnv = process.env['INKLOOM_LIBRARY']?.trim()
  return resolve(fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), 'inkloom'))
}

/** 允许中文目录名；只去掉 Windows 不接受的字符与保留名 */
export function sanitizeFolder(name: string): string {
  // 控制字符用码点过滤（正则里的控制字符类会被 lint 拦下）
  const cleaned = [...name]
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 60)
  const base = cleaned.length > 0 ? cleaned : 'book'
  return WINDOWS_RESERVED.has(base.toLowerCase()) ? `${base}-book` : base
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** chapters/ 下最新文件的 mtime；没有章节时回退 novel.json */
async function latestMtime(root: string): Promise<string> {
  let newest = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs, depth + 1)
      else if (e.isFile()) {
        const s = await stat(abs).catch(() => null)
        if (s !== null && s.mtimeMs > newest) newest = s.mtimeMs
      }
    }
  }
  await walk(join(root, 'chapters'), 0)
  if (newest === 0) {
    const s = await stat(join(root, 'novel.json')).catch(() => null)
    newest = s?.mtimeMs ?? 0
  }
  return new Date(newest).toISOString()
}

async function readBookMeta(rootPath: string, folder: string): Promise<LibraryBook | null> {
  const idFile = join(rootPath, '.inkloom', 'project-id')
  const novel = join(rootPath, 'novel.json')
  if (!(await exists(idFile)) || !(await exists(novel))) return null
  const raw = await readIfExists(novel)
  if (raw === null) return null
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    return {
      folder,
      rootPath,
      name: typeof data['name'] === 'string' ? data['name'] : folder,
      genre: typeof data['genre'] === 'string' ? data['genre'] : '',
      totalChapters: typeof data['totalChapters'] === 'number' ? data['totalChapters'] : null,
      updatedAt: await latestMtime(rootPath),
    }
  } catch {
    return null
  }
}

export async function listBooks(libraryRoot: string): Promise<LibraryBook[]> {
  await mkdir(libraryRoot, { recursive: true })
  const entries = await readdir(libraryRoot, { withFileTypes: true })
  const books: LibraryBook[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const meta = await readBookMeta(join(libraryRoot, e.name), e.name)
    if (meta !== null) books.push(meta)
  }
  return books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * 解析一个库内一级目录。
 *
 * ★ 先校验单段名（拒绝 `/`、`\\`、`..`），再用 realpath 比较：
 *   防止 junction/symlink 指到库外。
 */
export async function resolveBookDir(libraryRoot: string, folder: string): Promise<string> {
  if (folder.length === 0 || basename(folder) !== folder || folder === '.' || folder === '..') {
    throw new InkloomError('INVALID_INPUT', `不是合法的书目录名：${folder}`)
  }
  const rootReal = await realpath(libraryRoot)
  const target = join(libraryRoot, folder)
  const targetReal = await realpath(target).catch(() => {
    throw new InkloomError('NOT_FOUND', `书库中没有这本书：${folder}`)
  })
  const normalize = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = normalize(relative(rootReal, targetReal))
  if (rel.startsWith('..') || rel.length === 0) {
    throw new InkloomError('INVALID_INPUT', `目录不在书库内：${folder}`)
  }
  return targetReal
}

/** 建书：目录名冲突时加 -2、-3；绝不覆盖已有书 */
export async function createLibraryBook(
  libraryRoot: string,
  input: CreateBookInput,
): Promise<{ folder: string; rootPath: string; name: string }> {
  const name = input.name.trim()
  const genre = input.genre.trim()
  if (name.length === 0) throw new InkloomError('INVALID_INPUT', '书名不能为空')
  if (genre.length === 0) throw new InkloomError('INVALID_INPUT', '类型不能为空')

  await mkdir(libraryRoot, { recursive: true })
  const base = sanitizeFolder(name)
  let folder = base
  for (let i = 2; i < 100; i += 1) {
    if (!(await exists(join(libraryRoot, folder)))) break
    folder = `${base}-${i}`
  }
  const rootPath = join(libraryRoot, folder)
  await mkdir(rootPath, { recursive: true })
  const { project } = await createProject({
    rootPath,
    name,
    genre,
    ...(input.totalChapters === undefined ? {} : { totalChapters: input.totalChapters }),
    ...(input.wordsPerChapter === undefined ? {} : { wordsPerChapter: input.wordsPerChapter }),
  })
  return { folder, rootPath, name: project.name }
}

// ---------------------------------------------------------------------------
// 上次打开的书：存 OS 状态目录，不写进书库（避免污染书库自己的 git）
// ---------------------------------------------------------------------------

interface LibraryState {
  lastBook?: string
}

function stateFile(): string {
  return join(homedir(), '.inkloom', 'state.json')
}

export async function readLastBook(): Promise<string | null> {
  const raw = await readIfExists(stateFile())
  if (raw === null) return null
  try {
    const data = JSON.parse(raw) as LibraryState
    return typeof data.lastBook === 'string' ? data.lastBook : null
  } catch {
    return null
  }
}

/** 写失败只告警：记不住上次打开的书，不应该升级成打不开书 */
export async function rememberLastBook(rootPath: string): Promise<void> {
  await mkdir(join(homedir(), '.inkloom'), { recursive: true })
  await atomicWrite(
    stateFile(),
    `${JSON.stringify({ lastBook: rootPath } satisfies LibraryState, null, 2)}\n`,
  )
}
