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
 * ★ 按 payload.stateChapter 排序，**不是**按 version 排序。
 * 理由（ADR-13）：人可能回头补写第 3 章，此时最新 version 对应的却是第 3 章的状态，
 * 用它去写第 10 章会直接导致人物状态错乱。
 *
 * ★ stateChapter 的语义是「状态**从第几章起生效**」，不是「状态更新于第几章」。
 * 因此写第 N 章时取 `stateChapter <= N`。
 * ❗推论：定稿第 N 章时产生的状态变化，stateChapter 必须记为 **N + 1**。
 *   写成 N 会把「第 N 章结尾的伤」喂给「第 N 章开头」，AI 会据此写出时序矛盾。
 *   这个约束由 Task 16 的 finalizeChapter 负责。
 *
 * 同 stateChapter 时取 version 更大的（同一章的多次修订）。
 * 无匹配（角色尚未有生效状态）返回 null，调用方用文件里的静态设定兜底。
 */
export function resolveCharacterState(
  revisions: RevisionRecord[],
  characterId: string,
  chapterBeingWritten: number,
): CharacterStateSnapshot | null {
  let best: RevisionRecord | null = null
  let bestStateChapter = -1

  for (const r of revisions) {
    if (r.entityType !== 'character' || r.entityId !== characterId) continue
    const payload = parsePayload(r)
    const sc = payload['stateChapter']
    if (typeof sc !== 'number' || sc > chapterBeingWritten) continue
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
