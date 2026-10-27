import type { GraphIssue, GraphSnapshot } from './types.js'

/**
 * 结构校验（切片 1）。
 * ★ 只检查 canon 边的谓词与重复：虚拟边用 `rel:*`（不在注册表），且 relations/routes 允许同对节点多条（不同 mode/时段）。
 * ★ 切片 3 再补 domain/range、规则校验。
 */
export function validateGraph(snap: GraphSnapshot): GraphIssue[] {
  const issues: GraphIssue[] = []
  const classById = new Map(snap.classes.map((c) => [c.id, c]))
  /** 类 id 也是合法端点（spec §4.3：instanceOf 指向类） */
  const isEndpoint = (id: string): boolean => snap.nodes.has(id) || classById.has(id)
  const label = (id: string): string => snap.nodes.get(id)?.name ?? classById.get(id)?.name ?? id

  for (const c of snap.classes) {
    if (c.parentId !== null && !classById.has(c.parentId)) {
      issues.push({
        severity: 'error',
        code: 'CLASS_PARENT_MISSING',
        subject: c.id,
        message: `类「${c.name}」的父类 ${c.parentId} 不存在`,
      })
    }
  }

  const mark = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const reported = new Set<string>()
  const visit = (id: string): void => {
    const st = mark.get(id)
    if (st === 'done') return
    if (st === 'visiting') {
      if (!reported.has(id)) {
        reported.add(id)
        const from = stack.indexOf(id)
        const path = [...stack.slice(from === -1 ? 0 : from), id]
        issues.push({
          severity: 'error',
          code: 'CLASS_CYCLE',
          subject: id,
          // 环上全部成员（UI 据此标红整条分支）
          evidence: path.join(','),
          message: `类继承出现环：${path.map((x) => label(x)).join(' → ')}`,
        })
      }
      return
    }
    mark.set(id, 'visiting')
    stack.push(id)
    const parent = classById.get(id)?.parentId ?? null
    if (parent !== null && classById.has(parent)) visit(parent)
    stack.pop()
    mark.set(id, 'done')
  }
  for (const c of snap.classes) visit(c.id)

  const predicateIds = new Set(snap.predicates.map((p) => p.id))
  const firstSeenAt = new Map<string, string>()
  for (const e of snap.edges) {
    // 废止记录行只用于吊销：它的三要素与被吊销边相同，参与重复判定会误报
    if (e.tombstone === true) continue
    if (!isEndpoint(e.from) || !isEndpoint(e.to)) {
      const bad = [!isEndpoint(e.from) ? e.from : null, !isEndpoint(e.to) ? e.to : null].filter(
        (v): v is string => v !== null,
      )
      // 悬空边只提示不阻断（spec §6：不自动删，图谱页给「待修复」筛选）
      issues.push({
        severity: 'warning',
        code: 'EDGE_ENDPOINT_MISSING',
        subject: e.id,
        message: `边 ${e.id} 指向不存在的节点：${bad.join('、')}`,
      })
    }
    if (!e.virtual && !predicateIds.has(e.predicate)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_BAD_PREDICATE',
        subject: e.id,
        message: `边 ${e.id} 使用了未注册的谓词 ${e.predicate}（${label(e.from)} → ${label(e.to)}）`,
      })
    }
    // 被吊销的边不算重复：吊销后再断言是合法的重新主张；
    // 虚拟边不进重复判定：它们归 relations/routes 各自模块管，同一对节点允许多条
    if (e.virtual || e.retracted === true) continue
    const key = `${e.from}|${e.predicate}|${e.to}|${e.sinceChapter ?? ''}`
    const prev = firstSeenAt.get(key)
    if (prev === undefined) {
      firstSeenAt.set(key, e.id)
    } else {
      // 重复边必须拒绝落盘（spec §4.3），evidence 指向先出现的那条，UI 可一键定位两条
      issues.push({
        severity: 'error',
        code: 'DUP_EDGE',
        subject: e.id,
        evidence: prev,
        message: `重复边：${label(e.from)} -${e.predicate}-> ${label(e.to)}（同样的 sinceChapter，先有 ${prev}）`,
      })
    }
  }

  return issues
}
