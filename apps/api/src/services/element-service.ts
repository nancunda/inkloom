import { randomUUID } from 'node:crypto'
import {
  type ChangeSource,
  type EntityType,
  nextRevision,
  type RevisionRecord,
} from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { commitAll, initRepo } from '../git/runner.js'
import { syncElement } from '../index-db/sync.js'
import { hashContent } from '../storage/atomic-write.js'
import { readJsonElement, writeJsonElement } from '../storage/elements.js'
import { writeQueue } from '../storage/queue.js'
import { appendRevision, lastRevision, readRevisions } from '../storage/revisions.js'
import { getContext } from './context.js'

export interface UpsertElementInput {
  entityType: EntityType
  entityId: string
  /** 相对书根的路径，如 `characters/c1.json` */
  relPath: string
  payload: unknown
  changeSource: ChangeSource
  changeReason?: string
  /**
   * 调用方读到的文件 hash。
   *
   * ★ 数组文件（characters/index.json）与单实体 revision 不是同一个粒度：
   *   前者的 revision payload 是“某个角色的状态补丁”，拿它算出来的 hash
   *   永远对不上整个数组文件。这种情况下必须由读方带着自己看到的 hash 来，
   *   才是真正的乐观锁——“我基于这个版本改的”。
   */
  expectedHash?: string
}

export interface UpsertResult {
  version: number
  newHash: string
}

/** 已知已 init 的书根，避免每次写都 spawn 一次 git 探测 */
const repoReady = new Set<string>()

async function ensureRepo(root: string): Promise<void> {
  if (repoReady.has(root)) return
  await initRepo(root)
  repoReady.add(root)
}

/**
 * 从「上一条 revision」重算上次写入后文件应该有的 hash。
 *
 * ★ 这是 CAS 的唯一正确基准：不能用“实时读文件”的 hash 当期望值——
 *   那样任何外部改动都会被自动接受，CAS 变成空操作（等于没做校验）。
 *   基准必须是“我上次写下去的内容”，才能发现“这中间被人改了”。
 */
function expectedHashFromPrev(prev: RevisionRecord | null): string | null {
  if (prev === null) return null
  const payload: unknown = JSON.parse(prev.payload)
  return hashContent(`${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * 写一个要素 —— spec §2.6 写入顺序的完整落地。
 *
 * 顺序（不可调换）：
 *   0. 写前 CAS（读当前文件 hash）
 *   1–2. tmp → fsync → rename
 *   3. 追加 JSONL revision   ← 必须早于索引
 *   4. 更新索引（失败不阻塞）
 *   5. git commit
 *
 * 全程在单一写队列内，保证 version 单调与文件/历史/索引三者一致。
 */
export async function upsertElement(input: UpsertElementInput): Promise<UpsertResult> {
  const ctx = getContext()

  return writeQueue.run(async () => {
    await ensureRepo(ctx.root)

    const prev = await lastRevision(ctx.root, input.entityType, input.entityId)
    // 调用方带了 hash 就用它；否则退回“上一条 revision”基准
    const expectedHash = input.expectedHash ?? expectedHashFromPrev(prev)

    const revision: RevisionRecord = nextRevision({
      id: `rev_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      entityType: input.entityType,
      entityId: input.entityId,
      prev,
      payload: input.payload,
      changeSource: input.changeSource,
      ...(input.changeReason === undefined ? {} : { changeReason: input.changeReason }),
      now: new Date().toISOString(),
    })

    // 1–2. 文件（CAS 不符会在这里抛 CAS_MISMATCH，此时历史与索引都没动）
    const { newHash } = await writeJsonElement(ctx.root, input.relPath, input.payload, {
      expectedHash,
    })

    // 3. 历史（必须早于索引：索引可丢弃，历史不可删）
    await appendRevision(ctx.root, revision)

    // 4. 索引（失败只告警，不回滚——见 syncElement 的设计原则）
    const synced = await syncElement(ctx.db, ctx.project.id, input.entityType, input.payload)
    if (!synced.ok && synced.error !== undefined) {
      console.warn(
        `[index] ${input.entityType}/${input.entityId} 同步失败（reindex 可修复）：${synced.error}`,
      )
    }

    // 5. git
    await commitAll(ctx.root, `feat(${input.entityType}): ${input.entityId} v${revision.version}`)

    return { version: revision.version, newHash }
  })
}

export interface RollbackElementInput {
  entityType: EntityType
  entityId: string
  relPath: string
  toVersion: number
}

/**
 * 要素回退（P0-10 第三种）。
 *
 * ★ 回退 = 产生新版本，不改历史。旧版本永远在 JSONL 里。
 *   这样「回退」本身也可再回退，且 changeSource='rollback' 让历史可追溯。
 */
export async function rollbackElement(input: RollbackElementInput): Promise<UpsertResult> {
  const revs = await readRevisions(getContext().root, input.entityType, input.entityId)
  const target = revs.find((r) => r.version === input.toVersion)
  if (target === undefined) {
    throw new InkloomError(
      'NOT_FOUND',
      `${input.entityType}/${input.entityId} 不存在版本 ${input.toVersion}`,
    )
  }
  const payload: unknown = JSON.parse(target.payload)
  return upsertElement({
    entityType: input.entityType,
    entityId: input.entityId,
    relPath: input.relPath,
    payload,
    changeSource: 'rollback',
    changeReason: `回退到 v${input.toVersion}`,
  })
}

export async function listElementRevisions(
  entityType: EntityType,
  entityId: string,
): Promise<RevisionRecord[]> {
  return readRevisions(getContext().root, entityType, entityId)
}

/** 读要素当前值（文件为准，不是索引） */
export async function readElement(relPath: string): Promise<unknown | null> {
  return readJsonElement(getContext().root, relPath)
}
