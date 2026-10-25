import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { checkoutPaths, commitAll, currentHead, git, initRepo } from '../git/runner.js'
import { readIfExists } from './atomic-write.js'
import { bookPaths } from './paths.js'
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
  /** key = revision 文件相对路径，value = 当时的非空行数 */
  revisionsOffsets: Record<string, number>
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
 * 记录两样东西：Git HEAD + 每个 revision 文件的行数。
 * ★ 两者缺一不可 —— 只记 Git 会让要素状态「穿越」到未来章节。
 */
export async function createCheckpoint(root: string, label: string): Promise<Checkpoint> {
  await initRepo(root)
  // 先提交当前状态，保证 gitRef 指向「这一刻」而不是上一次提交
  await commitAll(root, `chore(checkpoint): ${label}`)
  const gitRef = await currentHead(root)

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
    revisionsOffsets,
  }
  await mkdir(bookPaths(root).inkloom, { recursive: true })
  await appendFile(join(root, checkpointRelPath()), `${JSON.stringify(ck)}\n`, 'utf8')
  return ck
}

export interface RollbackToCheckpointResult {
  restoredPaths: string[]
  truncatedRevisionFiles: string[]
  warnings: string[]
}

/**
 * 时间点回退（§2.7 五 / P0-10 第四种）。
 *
 * 步骤：git checkout <ref> -- <tracked> → 逐个截断 JSONL → 追加 rollback checkpoint。
 * ★ 顺序不可换：先恢复文件再截断历史。若中途崩溃，重跑本函数是幂等的
 *   （checkout 与 truncate 都幂等）。
 * ★ 必须同时回退两个事实源：只回 Git 会出现「正文回到第 7 章、角色状态还在第 12 章」。
 */
export async function rollbackToCheckpoint(
  root: string,
  checkpointId: string,
): Promise<RollbackToCheckpointResult> {
  const all = await readCheckpoints(root)
  const ck = all.find((c) => c.id === checkpointId)
  if (ck === undefined) {
    throw new InkloomError('NOT_FOUND', `checkpoint ${checkpointId} 不存在`)
  }

  const restoredPaths: string[] = []
  const truncatedRevisionFiles: string[] = []
  const warnings: string[] = []

  if (ck.gitRef === null) {
    warnings.push('该 checkpoint 没有 gitRef（创建时尚未提交），仅回退要素历史')
  } else {
    const paths = await trackedPathsAt(root, ck.gitRef)
    if (paths.length === 0) {
      warnings.push('该 commit 里没有受关注的文件，跳过文件恢复')
    } else {
      await checkoutPaths(root, ck.gitRef, paths)
      restoredPaths.push(...paths)
    }
  }

  for (const [rel, keepLines] of Object.entries(ck.revisionsOffsets)) {
    const ids = parseRevisionRelPath(rel)
    if (ids === null) {
      warnings.push(`无法解析 revision 文件名：${rel}`)
      continue
    }
    await truncateRevisions(root, ids.entityType, ids.entityId, keepLines)
    truncatedRevisionFiles.push(rel)
  }

  // 回退本身也留痕（P0-10 要求）
  await createCheckpoint(root, `回退到 ${ck.label} (${ck.id})`)

  return { restoredPaths, truncatedRevisionFiles, warnings }
}
