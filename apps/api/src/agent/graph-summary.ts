import type { GraphSnapshot } from '@inkloom/core'
import { getContext } from '../services/context.js'
import { listLore } from '../services/lore-service.js'
import { getGraphData } from '../services/ontology-service.js'

function classCounts(snap: GraphSnapshot): { id: string; name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const ids of snap.classOf.values()) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return snap.classes
    .map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * read_book 末尾的图谱概况（≤ 800 字）。
 * ★ 失败只降级成一行提示：图谱是辅助信息，不能把 read_book 一起拖垮。
 */
export async function renderGraphSummary(): Promise<string> {
  try {
    const { snapshot } = await getGraphData()
    const { db, project } = getContext()
    const lore = await listLore(db, project.id, { approved: true, limit: 5 })
    const errors = snapshot.issues.filter((i) => i.severity === 'error')

    const lines: string[] = ['## 图谱概况']
    lines.push(
      `${snapshot.nodes.size} 节点 · ${snapshot.edges.length} 边 · ${snapshot.classes.length} 类 · ${snapshot.issues.length} 问题（error ${errors.length}）`,
    )
    const top = classCounts(snapshot).slice(0, 8)
    if (top.length > 0) {
      lines.push(`各类实例：${top.map((c) => `${c.name} ${c.count}`).join(' · ')}`)
    }
    for (const issue of errors.slice(0, 3)) {
      lines.push(`- [${issue.code}] ${issue.message}`)
    }
    if (lore.length > 0) {
      lines.push(`已批准资料卡：${lore.map((l) => `${l.id} ${l.title}`).join(' · ')}`)
    } else {
      lines.push('已批准资料卡：无（web_search 搜到的卡要先请作者批准）')
    }
    return lines.join('\n').slice(0, 800)
  } catch (e) {
    return `## 图谱概况\n图谱概况不可用：${(e as Error).message}`
  }
}
