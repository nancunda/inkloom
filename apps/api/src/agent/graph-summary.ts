import type { GraphIssue, GraphSnapshot } from '@inkloom/core'
import { getContext } from '../services/context.js'
import { listLore } from '../services/lore-service.js'
import { getGraphData } from '../services/ontology-service.js'

const MAX_CHARS = 800
const MAX_ISSUE_CHARS = 80
const MAX_TITLE_CHARS = 40

function classCounts(snap: GraphSnapshot): { id: string; name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const ids of snap.classOf.values()) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return snap.classes
    .map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function clipLine(line: string): string {
  return line.length <= MAX_ISSUE_CHARS ? line : `${line.slice(0, MAX_ISSUE_CHARS)}…`
}

/** 按整体预算收尾：超了就切最后一处并留省略号，别让 Agent 读到半截标题 */
function fitBudget(lines: string[]): string {
  const joined = lines.join('\n')
  if (joined.length <= MAX_CHARS) return joined
  return `${joined.slice(0, MAX_CHARS - 1)}…`
}

function issueLine(issue: GraphIssue): string {
  return clipLine(`- [${issue.code}] ${issue.message}`)
}

/**
 * read_book 末尾的图谱概况（≤ 800 字）。
 * ★ 图谱与资料卡分开降级：索引库坏了不代表图谱坏了，不能一句「不可用」把两边都否掉。
 */
export async function renderGraphSummary(): Promise<string> {
  const lines: string[] = ['## 图谱概况']
  try {
    const { snapshot } = await getGraphData()
    // 口径与 /ontology/graph 一致：报废行/吊销边不算，instanceOf 归属边算在内
    const live = snapshot.edges.filter((e) => e.tombstone !== true && e.retracted !== true)
    const errors = snapshot.issues.filter((i) => i.severity === 'error')

    lines.push(
      `${snapshot.nodes.size} 节点 · ${live.length} 边 · ${snapshot.classes.length} 类 · ${snapshot.issues.length} 问题（error ${errors.length}）`,
    )
    const top = classCounts(snapshot).slice(0, 8)
    if (top.length > 0) {
      lines.push(`各类实例（含子类）：${top.map((c) => `${c.name} ${c.count}`).join(' · ')}`)
    }
    for (const issue of errors.slice(0, 3)) lines.push(issueLine(issue))
  } catch (e) {
    return `## 图谱概况\n图谱概况不可用：${(e as Error).message}`
  }

  try {
    const { db, project } = getContext()
    const lore = await listLore(db, project.id, { approved: true, limit: 5 })
    if (lore.length > 0) {
      const items = lore.map((l) => `${l.id} ${l.title.slice(0, MAX_TITLE_CHARS)}`)
      lines.push(`已批准资料卡：${items.join(' · ')}`)
    } else {
      lines.push('已批准资料卡：无（web_search 搜到的卡要先请作者批准）')
    }
  } catch {
    lines.push('已批准资料卡：暂不可用（索引查询失败，不代表没有资料卡）')
  }

  return fitBudget(lines)
}
