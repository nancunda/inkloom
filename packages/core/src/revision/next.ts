import { InkloomError } from '@inkloom/shared'
import type { ChangeSource, EntityType, RevisionRecord } from './types.js'

export interface NextRevisionInput {
  id: string
  entityType: EntityType
  entityId: string
  prev: RevisionRecord | null
  payload: unknown
  changeSource: ChangeSource
  changeReason?: string
  generationRunId?: string
  now: string
}

/**
 * 计算下一条 revision（spec §3.1 / ADR-27）。
 *
 * 铁律：只追加，不修改。version 单调递增，parentRevisionId 形成链。
 * 注意：正文（draft_segment）不在此列 —— 正文历史归 Git。
 */
export function nextRevision(input: NextRevisionInput): RevisionRecord {
  const { prev } = input

  // prev 必须属于同一实体。不校验的话，把 c1 的 prev 传给 c2 会静默串链：
  // version 从 10 开始、parentRevisionId 指向别人。
  if (prev !== null && (prev.entityType !== input.entityType || prev.entityId !== input.entityId)) {
    throw new InkloomError(
      'INVALID_INPUT',
      `prev 属于 ${prev.entityType}/${prev.entityId}，与当前 ${input.entityType}/${input.entityId} 不匹配`,
    )
  }

  // JSON.stringify 对 undefined / 函数 / Symbol 返回 undefined，会静默违反 payload: string
  const payload = JSON.stringify(input.payload)
  if (payload === undefined) {
    throw new InkloomError(
      'INVALID_INPUT',
      'payload 无法序列化为 JSON（undefined / 函数 / Symbol）',
    )
  }

  return {
    id: input.id,
    entityType: input.entityType,
    entityId: input.entityId,
    version: prev === null ? 1 : prev.version + 1,
    parentRevisionId: prev === null ? null : prev.id,
    payload,
    changeSource: input.changeSource,
    changeReason: input.changeReason ?? null,
    generationRunId: input.generationRunId ?? null,
    createdAt: input.now,
  }
}
