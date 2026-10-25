export type EntityType =
  | 'project'
  | 'character'
  | 'world_rule'
  | 'power_system'
  | 'power_tier'
  | 'blueprint'
  | 'plot_thread'
  | 'style_asset'
  | 'story_arc'
  | 'character_relation'
  | 'character_signature'
  | 'writing_technique'
  | 'location'
  | 'route'
  | 'lore_reference'

export type ChangeSource = 'human' | 'ai' | 'import' | 'rollback'

/**
 * 要素的一条版本快照。永不 UPDATE，永不 DELETE。
 *
 * ★ 不含 draft_segment：正文历史归 Git（ADR-27）。
 *   一旦这里出现正文，就会复活两套版本系统。
 */
export interface RevisionRecord {
  id: string
  entityType: EntityType
  entityId: string
  version: number
  parentRevisionId: string | null
  /** 完整 JSON 快照（不做 diff，自解释） */
  payload: string
  changeSource: ChangeSource
  changeReason: string | null
  generationRunId: string | null
  createdAt: string
}

export interface CharacterStateSnapshot {
  stateChapter: number
  revisionId: string
  stale: boolean
  state: Record<string, unknown>
}
