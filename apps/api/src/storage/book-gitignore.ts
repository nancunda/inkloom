import { join } from 'node:path'
import { git, isRepo } from '../git/runner.js'
import { atomicWrite, readIfExists } from './atomic-write.js'

/**
 * 索引是派生层（spec §2.7）：留在磁盘上，但不该进书的版本历史。
 *
 * ★ 这不是“洁癖”：SQLite 的 -wal 有 4MB，每写一个角色都会产生一个二进制
 *   commit，几个月后书内 git 会被这些文件撑爆，回退也变得极慢。
 * ★ 只停止跟踪、不重写历史：已经进去的旧 blob 留着，从下一次提交开始不再变大。
 */
const IGNORE_LINES = [
  '# inkloom：索引是可丢弃的派生层，删除后可用 inkloom reindex 重建',
  '.inkloom/index.sqlite',
  '.inkloom/index.sqlite-wal',
  '.inkloom/index.sqlite-shm',
]

const INDEX_PATHS = [
  '.inkloom/index.sqlite',
  '.inkloom/index.sqlite-wal',
  '.inkloom/index.sqlite-shm',
]

export interface GitignoreResult {
  /** 本次新写入的忽略规则 */
  added: string[]
  /** 从 git 索引里移除跟踪（文件仍在磁盘） */
  untracked: string[]
}

export async function ensureBookGitignore(root: string): Promise<GitignoreResult> {
  const file = join(root, '.gitignore')
  const raw = (await readIfExists(file)) ?? ''
  const have = new Set(
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  )
  const missing = IGNORE_LINES.filter((l) => !have.has(l))
  if (missing.length > 0) {
    const prefix = raw.length === 0 || raw.endsWith('\n') ? raw : `${raw}\n`
    await atomicWrite(file, `${prefix}${missing.join('\n')}\n`)
  }

  const untracked: string[] = []
  if (await isRepo(root)) {
    const listed = await git(root, ['ls-files', '--', ...INDEX_PATHS])
    const tracked = listed
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (tracked.length > 0) {
      await git(root, ['rm', '--cached', '-f', '--ignore-unmatch', '--', ...tracked])
      untracked.push(...tracked)
    }
  }
  return { added: missing, untracked }
}
