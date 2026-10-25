import type { CharacterStateSnapshot, EntityType, RevisionRecord } from './types.js'

function parsePayload(r: RevisionRecord): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(r.payload)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 取实体最新版本（按 version 最大）。用于要素的“当前值”。 */
export function resolveLatest<T>(
  revisions: RevisionRecord[],
  entityType: EntityType,
  entityId: string,
): T | null {
  let best: RevisionRecord | null = null
  for (const r of revisions) {
    if (r.entityType !== entityType || r.entityId !== entityId) continue
    if (best === null || r.version > best.version) best = r
  }
  return best === null ? null : (parsePayload(best) as T)
}

/**
 * 推导角色在第 N 章时的状态（spec §4.8）。
 *
 * ★ 关键：按 payload.stateChapter 排序，**不是**按 version 排序。
 * 理由（ADR-13）：人可能回头补写第 3 章，此时最新 version 对应的却是第 3 章的状态，
 * 用它去写第 10 章会直接导致人物状态错乱。
 *
 * 同 stateChapter 时取 version 更大的（同一章的多次修订）。
 * 无匹配（角色尚未入场）返回 null。
 */
export function resolveCharacterState(
  revisions: RevisionRecord[],
  characterId: string,
  chapterNo: number,
): CharacterStateSnapshot | null {
  let best: RevisionRecord | null = null
  let bestStateChapter = -1

  for (const r of revisions) {
    if (r.entityType !== 'character' || r.entityId !== characterId) continue
    const payload = parsePayload(r)
    const sc = payload['stateChapter']
    if (typeof sc !== 'number' || sc > chapterNo) continue
    const better =
      sc > bestStateChapter ||
      (sc === bestStateChapter && (best === null || r.version > best.version))
    if (better) {
      best = r
      bestStateChapter = sc
    }
  }

  if (best === null) return null
  const state = parsePayload(best)
  return {
    stateChapter: bestStateChapter,
    revisionId: best.id,
    stale: state['stateStale'] === true,
    state,
  }
}
