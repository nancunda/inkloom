import type { EntityType } from '@inkloom/core'
import type { IndexDb } from './client.js'

export interface SyncResult {
  ok: boolean
  skipped?: boolean
  error?: string
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/**
 * 把一条要素写入索引（spec §2.6 步骤 4）。
 *
 * ★ 设计原则：**失败绝不阻塞写入**。
 *   索引是可丢弃的派生层，写入失败只需标记 dirty，待下次 reindex 修复。
 *   反过来——如果因为索引失败而回滚文件写入，就把「可丢弃」变成了关键路径。
 *
 * P0 只覆盖四种高频实体，其余类型返回 skipped（仍可 reindex 重建）。
 */
export async function syncElement(
  db: IndexDb,
  projectId: string,
  entityType: EntityType,
  payload: unknown,
): Promise<SyncResult> {
  const p = rec(payload)
  const id = str(p['id'])
  if (id === null) return { ok: false, error: 'payload 缺少 id' }

  try {
    switch (entityType) {
      case 'character':
        await db.character.upsert({
          where: { id },
          create: {
            id,
            projectId,
            name: str(p['name']) ?? '',
            role: str(p['role']) ?? 'minor',
            personality: str(p['personality']),
            background: str(p['background']),
            curPhysical: str(p['curPhysical']),
            curTierId: str(p['curTierId']),
            stateChapter: num(p['stateChapter']),
            stateStale: p['stateStale'] === true,
          },
          update: {
            name: str(p['name']) ?? '',
            role: str(p['role']) ?? 'minor',
            personality: str(p['personality']),
            background: str(p['background']),
            curPhysical: str(p['curPhysical']),
            curTierId: str(p['curTierId']),
            stateChapter: num(p['stateChapter']),
            stateStale: p['stateStale'] === true,
          },
        })
        return { ok: true }

      case 'blueprint':
        await db.blueprint.upsert({
          where: { projectId_chapterNo: { projectId, chapterNo: num(p['chapterNo']) ?? 0 } },
          create: {
            id,
            projectId,
            chapterNo: num(p['chapterNo']) ?? 0,
            title: str(p['title']),
            goal: str(p['goal']) ?? '',
            conflict: str(p['conflict']) ?? '',
            hook: str(p['hook']) ?? '',
            castIds: JSON.stringify(p['castIds'] ?? []),
            beatType: str(p['beatType']) ?? 'rising',
            tensionLevel: num(p['tensionLevel']) ?? 3,
          },
          update: {
            title: str(p['title']),
            goal: str(p['goal']) ?? '',
            conflict: str(p['conflict']) ?? '',
            hook: str(p['hook']) ?? '',
            castIds: JSON.stringify(p['castIds'] ?? []),
            beatType: str(p['beatType']) ?? 'rising',
            tensionLevel: num(p['tensionLevel']) ?? 3,
          },
        })
        return { ok: true }

      case 'world_rule':
        await db.worldRule.upsert({
          where: { id },
          create: {
            id,
            projectId,
            category: str(p['category']) ?? 'power',
            name: str(p['name']) ?? '',
            content: str(p['content']) ?? '',
            priority: str(p['priority']) ?? 'soft',
          },
          update: {
            category: str(p['category']) ?? 'power',
            name: str(p['name']) ?? '',
            content: str(p['content']) ?? '',
            priority: str(p['priority']) ?? 'soft',
          },
        })
        return { ok: true }

      case 'plot_thread':
        await db.plotThread.upsert({
          where: { id },
          create: {
            id,
            projectId,
            kind: str(p['kind']) ?? 'setup',
            title: str(p['title']) ?? '',
            plantedChapter: num(p['plantedChapter']),
            advancedChapters: JSON.stringify(p['advancedChapters'] ?? []),
            resolvedChapter: num(p['resolvedChapter']),
            status: str(p['status']) ?? 'active',
          },
          update: {
            kind: str(p['kind']) ?? 'setup',
            title: str(p['title']) ?? '',
            plantedChapter: num(p['plantedChapter']),
            advancedChapters: JSON.stringify(p['advancedChapters'] ?? []),
            resolvedChapter: num(p['resolvedChapter']),
            status: str(p['status']) ?? 'active',
          },
        })
        return { ok: true }

      default:
        // 其余类型 P0 不做实时同步（仍可 reindex 重建）
        return { ok: true, skipped: true }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
