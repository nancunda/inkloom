import { execFile, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { InkloomError } from '@inkloom/shared'
import { WriteQueue } from '../storage/queue.js'

const exec = promisify(execFile)

/**
 * Git 子进程独立串行队列（spec §2.6 并发控制）。
 *
 * 不能与文件写队列共用一个实例——Git 自身会拿 index.lock，
 * 与文件写混在一起会互相阻塞，导致长任务卡死整个应用。
 */
const gitQueue = new WriteQueue()

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'inkloom',
  GIT_AUTHOR_EMAIL: 'inkloom@localhost',
  GIT_COMMITTER_NAME: 'inkloom',
  GIT_COMMITTER_EMAIL: 'inkloom@localhost',
}

/**
 * 本目录本身就是 git 仓库根吗？
 *
 * ★ 不能用 `git rev-parse --git-dir`：它会**向上查找**父仓库。
 *   后果：书建在任何已有 git 仓库的目录下时（比如仓库内的 fixtures/），
 *   initRepo 会误判“已是仓库”而不创建自己的 .git，
 *   于是这本书的每一次 commit 都落进**父仓库**，污染用户的仓库历史。
 */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
    return resolve(stdout.trim()) === resolve(cwd)
  } catch {
    return false
  }
}

/** 幂等：已是 repo 时什么都不做 */
export async function initRepo(cwd: string): Promise<void> {
  if (await isRepo(cwd)) return
  await gitQueue.run(async () => {
    try {
      await exec('git', ['init', '-b', 'main'], { cwd, env: { ...process.env, ...IDENTITY_ENV } })
    } catch (e) {
      throw new InkloomError('GIT_FAILED', `git init 失败：${(e as Error).message}`)
    }
  })
}

/** 所有 git 调用的唯一入口，强制串行 */
export async function git(cwd: string, args: string[]): Promise<string> {
  return gitQueue.run(async () => {
    try {
      const { stdout } = await exec('git', args, {
        cwd,
        env: { ...process.env, ...IDENTITY_ENV },
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr ?? (e as Error).message
      throw new InkloomError('GIT_FAILED', `git ${args.join(' ')} 失败：${stderr.trim()}`)
    }
  })
}

/**
 * 用 stdin 传 commit message。
 *
 * ★ 为什么不用 `-m`：Windows 上 PowerShell 会把中文参数按 GBK 转码，
 *   提交信息落库后就是乱码。这里直接送 UTF-8 字节给 git 的 stdin。
 */
function commitWithStdin(cwd: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['commit', '-F', '-'], {
      cwd,
      env: { ...process.env, ...IDENTITY_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new InkloomError('GIT_FAILED', `git commit 失败：${stderr.trim()}`))
    })
    child.stdin.end(Buffer.from(message, 'utf8'))
  })
}

export interface CommitResult {
  committed: boolean
  hash: string | null
}

/**
 * 提交工作区全部改动（spec §2.5 版本用 Git）。
 * 幂等：无变更时返回 { committed: false }，不产生空 commit。
 */
export async function commitAll(cwd: string, message: string): Promise<CommitResult> {
  return gitQueue.run(async () => {
    if (!(await isRepo(cwd))) {
      throw new InkloomError('GIT_FAILED', `${cwd} 不是 git 仓库`)
    }
    await exec('git', ['add', '-A'], { cwd, env: { ...process.env, ...IDENTITY_ENV } })
    const { stdout: status } = await exec('git', ['status', '--porcelain'], {
      cwd,
      env: { ...process.env, ...IDENTITY_ENV },
    })
    if (status.trim().length === 0) return { committed: false, hash: null }

    await commitWithStdin(cwd, message)

    const { stdout: hash } = await exec('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      env: { ...process.env, ...IDENTITY_ENV },
    })
    return { committed: true, hash: hash.trim() }
  })
}

export async function currentHead(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', 'HEAD'])
    return out.trim()
  } catch {
    return null
  }
}

/** 把指定路径恢复到某个 commit（时间点回退用） */
export async function checkoutPaths(cwd: string, ref: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // ★ 只保留「ref 里真实存在」的 pathspec：不匹配的 pathspec 会让整条命令失败。
  //   不能用磁盘上的存在性判断——回退前用户可能把整个 chapters/ 删了，
  //   而 checkout 本应该把整个目录重新创建出来；按磁盘过滤会让回退直接失败。
  const listed = await git(cwd, ['ls-tree', '--name-only', ref, '--', ...paths])
  const present = new Set(
    listed
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  const existing = paths.filter((p) => present.has(p))
  if (existing.length === 0) return
  await git(cwd, ['checkout', ref, '--', ...existing])
}

export async function hasChanges(cwd: string, paths: string[]): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain', '--', ...paths])
  return out.trim().length > 0
}
