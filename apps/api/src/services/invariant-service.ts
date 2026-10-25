import type { EntityType } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import type { IndexDb } from '../index-db/client.js'
import { getContext } from './context.js'
import { listElementRevisions, type UpsertResult, upsertElement } from './element-service.js'

/**
 * P0-22 章节号不可变。
 *
 * 允许：追加（chapterNo > max）、更新已存在的章。
 * 拒绝：中间插入（chapterNo < max 且该章不存在）。
 *
 * 理由：章号是跨表引用键（蓝图 / 正文 / 摘要 / 伏笔都指向它）。
 * 允许中间插入就必须对后续所有章重编号，这是不可接受的隐式副作用。
 */
export async function assertChapterAppendOnly(
  db: IndexDb,
  projectId: string,
  chapterNo: number,
): Promise<void> {
  const maxRow = await db.blueprint.findFirst({
    where: { projectId },
    orderBy: { chapterNo: 'desc' },
    select: { chapterNo: true },
  })
  const max = maxRow?.chapterNo ?? 0
  if (chapterNo > max) return // 追加

  const exists = await db.blueprint.findUnique({
    where: { projectId_chapterNo: { projectId, chapterNo } },
    select: { id: true },
  })
  if (exists !== null) return // 更新已有章

  throw new InkloomError(
    'CONFLICT',
    `第 ${chapterNo} 章不存在但小于已有最大章号 ${max}；P0-22 只允许末尾追加，不支持中间插入`,
  )
}

export interface SoftDeleteInput {
  entityType: EntityType
  entityId: string
  relPath: string
}

/**
 * 软删除（P0-11）。
 *
 * 语义：写一个新版本，在 payload 上加 deletedAt，**原数据完整保留**。
 * 这样「删除」本身也可回退（回退到删除前的版本即可）。
 */
export async function softDeleteElement(input: SoftDeleteInput): Promise<UpsertResult> {
  const revs = await listElementRevisions(input.entityType, input.entityId)
  const latest = revs[revs.length - 1]
  if (latest === undefined) {
    throw new InkloomError('NOT_FOUND', `${input.entityType}/${input.entityId} 不存在`)
  }
  const payload: Record<string, unknown> = {
    ...(JSON.parse(latest.payload) as Record<string, unknown>),
  }
  payload['deletedAt'] = new Date().toISOString()
  return upsertElement({ ...input, payload, changeSource: 'human', changeReason: '软删除' })
}

/** 恢复软删除：写一个新版本，去掉 deletedAt */
export async function restoreElement(input: SoftDeleteInput): Promise<UpsertResult> {
  const revs = await listElementRevisions(input.entityType, input.entityId)
  const latest = revs[revs.length - 1]
  if (latest === undefined) {
    throw new InkloomError('NOT_FOUND', `${input.entityType}/${input.entityId} 不存在`)
  }
  const payload: Record<string, unknown> = {
    ...(JSON.parse(latest.payload) as Record<string, unknown>),
  }
  delete payload['deletedAt']
  return upsertElement({ ...input, payload, changeSource: 'human', changeReason: '恢复删除' })
}

/** 判断某要素当前是否被软删除 */
export async function isSoftDeleted(entityType: EntityType, entityId: string): Promise<boolean> {
  const revs = await listElementRevisions(entityType, entityId)
  const latest = revs[revs.length - 1]
  if (latest === undefined) return false
  const payload = JSON.parse(latest.payload) as Record<string, unknown>
  return typeof payload['deletedAt'] === 'string'
}

/** 当前上下文里的 projectId（给需要校验的调用方用） */
export function currentProjectId(): string {
  return getContext().project.id
}
