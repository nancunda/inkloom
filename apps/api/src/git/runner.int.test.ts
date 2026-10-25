import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkoutPaths,
  commitAll,
  currentHead,
  git,
  hasChanges,
  initRepo,
  isRepo,
} from './runner.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkloom-git-'))
  await initRepo(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('initRepo / isRepo', () => {
  it('init 后 isRepo 为 true', async () => {
    expect(await isRepo(dir)).toBe(true)
  })

  it('未 init 的目录 isRepo 为 false', async () => {
    const other = await mkdtemp(join(tmpdir(), 'inkloom-nogit-'))
    try {
      expect(await isRepo(other)).toBe(false)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('重复 init 不报错（幂等）', async () => {
    await expect(initRepo(dir)).resolves.toBeUndefined()
  })

  it('★ 父仓库内的子目录 isRepo 为 false（否则书会把 commit 落进父仓库）', async () => {
    const sub = join(dir, 'sub-book')
    await mkdir(sub, { recursive: true })
    // 子目录在父仓库内，但自己还不是仓库
    expect(await isRepo(sub)).toBe(false)

    // 先在父仓库提交（此时 sub 还没有 .git，不会被 git add -A 拒绝）
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    await commitAll(dir, 'parent 1')
    const before = Number((await git(dir, ['rev-list', '--count', 'HEAD'])).trim())

    // 子目录初始化自己的仓库后，两边的 commit 互不干扰
    await initRepo(sub)
    expect(await isRepo(sub)).toBe(true)
    expect(await isRepo(dir)).toBe(true)

    await writeFile(join(sub, 'x.md'), 'x', 'utf8')
    const r = await commitAll(sub, 'sub commit')
    expect(r.committed).toBe(true)

    const after = Number((await git(dir, ['rev-list', '--count', 'HEAD'])).trim())
    expect(after).toBe(before)
  })
})

describe('commitAll', () => {
  it('首次提交返回 hash', async () => {
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    const r = await commitAll(dir, 'chore: 初始化')
    expect(r.committed).toBe(true)
    expect(r.hash).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('无变更时 committed=false，hash 为 null（不产空 commit）', async () => {
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    await commitAll(dir, 'first')
    const r = await commitAll(dir, 'second')
    expect(r.committed).toBe(false)
    expect(r.hash).toBeNull()
  })

  it('连续三次变更产生三个 commit', async () => {
    for (const [i, c] of ['甲', '乙', '丙'].entries()) {
      await writeFile(join(dir, 'a.md'), c, 'utf8')
      const r = await commitAll(dir, `change ${i}`)
      expect(r.committed).toBe(true)
    }
    const out = await git(dir, ['rev-list', '--count', 'HEAD'])
    expect(Number(out.trim())).toBe(3)
  })

  it('★ 中文 commit message 不乱码（UTF-8 走 stdin）', async () => {
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    await commitAll(dir, 'feat: 中文提交信息')
    const shown = await git(dir, ['log', '-1', '--pretty=format:%s'])
    expect(shown.trim()).toBe('feat: 中文提交信息')
  })
})

describe('checkoutPaths', () => {
  it('恢复到指定 commit 的文件内容', async () => {
    await writeFile(join(dir, 'a.md'), '第一版', 'utf8')
    const { hash } = await commitAll(dir, 'v1')
    await writeFile(join(dir, 'a.md'), '第二版', 'utf8')
    await commitAll(dir, 'v2')

    if (hash === null) throw new Error('首次提交应返回 hash')
    await checkoutPaths(dir, hash, ['a.md'])
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('第一版')
  })

  it('★ 不存在的路径被跳过而不是整体失败（时间点回退时该文件可能还不存在）', async () => {
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    const { hash } = await commitAll(dir, 'v1')
    if (hash === null) throw new Error('首次提交应返回 hash')
    await expect(checkoutPaths(dir, hash, ['nope.md'])).resolves.toBeUndefined()
    // 混合存在与不存在的路径：存在的那些仍应恢复
    await expect(checkoutPaths(dir, hash, ['a.md', 'nope.md'])).resolves.toBeUndefined()
  })

  it('空路径列表直接返回', async () => {
    await expect(checkoutPaths(dir, 'HEAD', [])).resolves.toBeUndefined()
  })
})

describe('currentHead / hasChanges', () => {
  it('无 commit 时 currentHead 为 null', async () => {
    expect(await currentHead(dir)).toBeNull()
  })

  it('有 commit 时返回完整 hash（与 commitAll 的短 hash 同前缀）', async () => {
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    const { hash } = await commitAll(dir, 'v1')
    const head = await currentHead(dir)
    expect(head).not.toBeNull()
    expect(head?.startsWith(hash ?? '')).toBe(true)
  })

  it('hasChanges 反映指定路径是否有未提交改动', async () => {
    await writeFile(join(dir, 'a.md'), '甲', 'utf8')
    await commitAll(dir, 'v1')
    expect(await hasChanges(dir, ['a.md'])).toBe(false)
    await writeFile(join(dir, 'a.md'), '乙', 'utf8')
    expect(await hasChanges(dir, ['a.md'])).toBe(true)
  })
})

describe('并发安全', () => {
  it('★ 10 个并发 commit 不产生 index.lock 错误（独立串行队列）', async () => {
    // 先写完全部文件，再并发 commit。语义：
    // commitAll 是 `git add -A`，所以第一个提交会包含全部文件，
    // 后续发现无变更而返回 committed=false —— 这本身就是幂等的正确行为。
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `f${i}.md`), `内容${i}`, 'utf8')
    }
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => commitAll(dir, `c${i}`)))
    // 关键断言：全部 resolve（无 GIT_FAILED: index.lock），且至少一个真的提交了
    expect(results.filter((r) => r.committed).length).toBeGreaterThanOrEqual(1)
    const out = await git(dir, ['rev-list', '--count', 'HEAD'])
    expect(Number(out.trim())).toBe(1)
  })

  it('串行 10 次变更产生 10 个 commit', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `g${i}.md`), `内容${i}`, 'utf8')
      const r = await commitAll(dir, `s${i}`)
      expect(r.committed).toBe(true)
    }
    const out = await git(dir, ['rev-list', '--count', 'HEAD'])
    expect(Number(out.trim())).toBe(10)
  })
})
