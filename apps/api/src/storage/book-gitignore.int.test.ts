import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitAll, git, initRepo } from '../git/runner.js'
import { ensureBookGitignore } from './book-gitignore.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-ignore-'))
  await initRepo(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ensureBookGitignore', () => {
  it('新书：写入 .gitignore 且可重复调用', async () => {
    const first = await ensureBookGitignore(root)
    expect(first.added).toContain('.inkloom/index.sqlite')
    const second = await ensureBookGitignore(root)
    expect(second.added).toEqual([])
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.inkloom/index.sqlite')
  })

  it('★ 老书：索引已被跟踪时停止跟踪，但文件仍在磁盘上', async () => {
    await mkdir(join(root, '.inkloom'), { recursive: true })
    const index = join(root, '.inkloom', 'index.sqlite')
    await writeFile(index, 'sqlite-bytes', 'utf8')
    await commitAll(root, 'chore: 初始化（索引误入库）')
    expect(await git(root, ['ls-files', '--', '.inkloom/index.sqlite'])).toContain('index.sqlite')

    const r = await ensureBookGitignore(root)

    expect(r.untracked).toContain('.inkloom/index.sqlite')
    expect(await git(root, ['ls-files', '--', '.inkloom/index.sqlite'])).toBe('')
    expect(await readFile(index, 'utf8')).toBe('sqlite-bytes')
  })
})
