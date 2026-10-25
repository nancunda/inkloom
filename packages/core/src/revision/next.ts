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
  return {
    id: input.id,
    entityType: input.entityType,
    entityId: input.entityId,
    version: prev === null ? 1 : prev.version + 1,
    parentRevisionId: prev === null ? null : prev.id,
    payload: JSON.stringify(input.payload),
    changeSource: input.changeSource,
    changeReason: input.changeReason ?? null,
    generationRunId: input.generationRunId ?? null,
    createdAt: input.now,
  }
}
