import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { checkoutPaths, commitAll, currentHead, git, initRepo } from '../git/runner.js'
import { readIfExists } from './atomic-write.js'
import { ensureBookGitignore } from './book-gitignore.js'
import { bookPaths } from './paths.js'
import { writeQueue } from './queue.js'
import {
  countRevisionLines,
  parseRevisionRelPath,
  readAllRevisionFiles,
  truncateRevisions,
} from './revisions.js'

export interface Checkpoint {
  id: string
  label: string
  createdAt: string
  gitRef: string | null
  /** 该 commit 的树哈希：回退后用它自证「真的回到了那一刻」 */
  treeHash?: string | null
  /** key = revision 文件相对路径，value = 当时的非空行数 */
  revisionsOffsets: Record<string, number>
  /** 记录格式版本：1 = 旧版（无 treeHash），2 = 带树哈希 */
  schemaVersion?: number
}

export function checkpointRelPath(): string {
  return '.inkloom/checkpoints.jsonl'
}

/** 时间点回退关注的顶层条目（spec §2.7 五） */
const TRACKED_DIRS = ['chapters', 'characters', 'world', 'story', 'styles', 'novel.json']

/**
 * 某个 commit 里**实际存在**的受关注条目。
 *
 * ★ 不能直接用 TRACKED_DIRS：空目录不被 git 跟踪，
 *   而 `git checkout <ref> -- <paths>` 对不匹配的 pathspec 会**整体失败**。
 *   “建书后还没写任何一章”时 chapters/ 就是个空目录，硬传会让回退直接报错。
 */
async function trackedPathsAt(root: string, ref: string): Promise<string[]> {
  const out = await git(root, ['ls-tree', '--name-only', ref])
  const present = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return present.filter((p) => TRACKED_DIRS.includes(p))
}

export async function readCheckpoints(root: string): Promise<Checkpoint[]> {
  const raw = await readIfExists(join(root, checkpointRelPath()))
  if (raw === null) return []
  const out: Checkpoint[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    try {
      out.push(JSON.parse(t) as Checkpoint)
    } catch {
      // 跳过损坏行
    }
  }
  return out
}

/**
 * 建检查点（§2.7 五）。
 *
 * 记录三样东西：Git HEAD、该 commit 的树哈希、每个 revision 文件的行数。
 * ★ 三者缺一不可 —— 只记 Git 会让要素状态「穿越」到未来章节；
 *   树哈希让回退后能自证「工作区与那一刻完全一致」。
 * ★ 记录本身也要提交：否则「回过退」这件事在 git 历史里看不见（验收发现的洞）。
 */
async function createCheckpointUnlocked(
  root: string,
  label: string,
  commitMessage?: string,
): Promise<Checkpoint> {
  await initRepo(root)
  await ensureBookGitignore(root)
  // 先提交当前状态，保证 gitRef 指向「这一刻」而不是上一次提交
  await commitAll(root, commitMessage ?? `chore(checkpoint): ${label}`)
  const gitRef = await currentHead(root)
  const treeHash =
    gitRef === null ? null : (await git(root, ['rev-parse', `${gitRef}^{tree}`])).trim()

  const revisionsOffsets: Record<string, number> = {}
  for (const rel of await readAllRevisionFiles(root)) {
    const ids = parseRevisionRelPath(rel)
    if (ids === null) continue
    revisionsOffsets[rel] = await countRevisionLines(root, ids.entityType, ids.entityId)
  }

  const ck: Checkpoint = {
    id: `ck-${randomUUID().slice(0, 8)}`,
    label,
    createdAt: new Date().toISOString(),
    gitRef,
    treeHash,
    revisionsOffsets,
    schemaVersion: 2,
  }
  await mkdir(bookPaths(root).inkloom, { recursive: true })
  await appendFile(join(root, checkpointRelPath()), `${JSON.stringify(ck)}\n`, 'utf8')
  // 记录本身也进历史：回退记录不能只活在未被跟踪的工作区里
  await commitAll(root, `chore(checkpoint): 记录 ${label}`)
  return ck
}

/** 与要素写入共用一把锁：回退与“正在保存的角色”不能交错 */
export async function createCheckpoint(root: string, label: string): Promise<Checkpoint> {
  return writeQueue.run(() => createCheckpointUnlocked(root, label))
}

export interface RollbackToCheckpointResult {
  restoredPaths: string[]
  truncatedRevisionFiles: string[]
  warnings: string[]
}

/**
 * 时间点回退（§2.7 五 / P0-10 第四种）。
 *
 * 验收发现旧实现的三个洞，这里逐个堵上：
 *   1. `git checkout <ref> -- <dir>` **不会删除**回退后新增的文件 → 先把
 *      “HEAD 有、目标 ref 没有”的受管文件删掉（git rm -f）；
 *   2. 回退可能什么都没改（新增文件没被算作改动）→ 至少永远先做一次
 *      “回退前快照”，并在最后把回退记录本身提交进 git；
 *   3. 新实体的 revision 文件不在 offsets 里 → 一律截到 0 行，否则历史会
 *      留下“已经不存在的角色”的修改记录。
 *
 * ★ 恢复后必须自证：`git diff <ref> -- <受管目录>` 必须为空。不一致就中止，
 *   不写回退记录——宁可不回退，也不能回退到一个自己都不确定的状态。
 */
export async function rollbackToCheckpoint(
  root: string,
  checkpointId: string,
): Promise<RollbackToCheckpointResult> {
  return writeQueue.run(async () => {
    const all = await readCheckpoints(root)
    const ck = all.find((c) => c.id === checkpointId)
    if (ck === undefined) {
      throw new InkloomError('NOT_FOUND', `checkpoint ${checkpointId} 不存在`)
    }

    const restoredPaths: string[] = []
    const truncatedRevisionFiles: string[] = []
    const warnings: string[] = []

    await initRepo(root)
    await ensureBookGitignore(root)

    // 0) 回退是破坏性的：先把“现在”完整提交，保证任何未提交改动都能找回
    await commitAll(root, `chore(rollback): 回退前快照（${ck.label}）`)

    if (ck.gitRef === null) {
      warnings.push('该 checkpoint 没有 gitRef（创建时尚未提交），仅回退要素历史')
    } else {
      // 树哈希一致性：git 历史被改写时（rebase/filter-branch）先告警再按当前内容回退
      if (ck.treeHash !== undefined && ck.treeHash !== null) {
        const actualTree = (await git(root, ['rev-parse', `${ck.gitRef}^{tree}`])).trim()
        if (actualTree !== ck.treeHash) {
          warnings.push(
            'checkpoint 记录的树哈希与 git 不一致（历史可能被改写），按当前 git 内容回退',
          )
        }
      }

      const paths = await trackedPathsAt(root, ck.gitRef)
      if (paths.length === 0) {
        warnings.push('该 commit 里没有受关注的文件，跳过文件恢复')
      } else {
        await checkoutPaths(root, ck.gitRef, paths)
        restoredPaths.push(...paths)
      }

      // 1) 删除“目标树里没有、现在却有”的受管文件：checkout 不会替你做这件事
      const addedRaw = await git(root, [
        'diff',
        '--name-only',
        '--diff-filter=A',
        ck.gitRef,
        'HEAD',
        '--',
        ...TRACKED_DIRS,
      ])
      const added = addedRaw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (added.length > 0) {
        await git(root, ['rm', '-f', '--ignore-unmatch', '--', ...added])
      }

      // 2) 自证：工作区必须与目标 commit 完全一致，否则中止
      const driftRaw = await git(root, ['diff', '--name-only', ck.gitRef, '--', ...TRACKED_DIRS])
      const drift = driftRaw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (drift.length > 0) {
        throw new InkloomError(
          'GIT_FAILED',
          `回退校验失败：${drift.slice(0, 5).join('、')} 与目标版本不一致（已保留回退前快照）`,
        )
      }
    }

    // 3) 要素历史：offsets 里没有的文件 = 检查点之后新建的实体 → 截到 0 行
    for (const rel of await readAllRevisionFiles(root)) {
      const ids = parseRevisionRelPath(rel)
      if (ids === null) {
        warnings.push(`无法解析 revision 文件名：${rel}`)
        continue
      }
      const keepLines = ck.revisionsOffsets[rel] ?? 0
      await truncateRevisions(root, ids.entityType, ids.entityId, keepLines)
      truncatedRevisionFiles.push(rel)
    }

    // 4) 回退本身也留痕；记录连同恢复后的文件一起提交
    await createCheckpointUnlocked(
      root,
      `回退到 ${ck.label} (${ck.id})`,
      `chore(rollback): 回到 ${ck.label} (${ck.id})`,
    )

    return { restoredPaths, truncatedRevisionFiles, warnings }
  })
}
