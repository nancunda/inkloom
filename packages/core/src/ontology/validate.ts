import type { GraphIssue, GraphSnapshot } from './types.js'

/**
 * 结构校验（切片 1）。
 * ★ 只检查 canon 边：虚拟边由各自 schema（relations/routes）保证，重复报错只会是噪音。
 * ★ 切片 3 再补 domain/range、规则校验。
 */
export function validateGraph(snap: GraphSnapshot): GraphIssue[] {
  const issues: GraphIssue[] = []
  const classById = new Map(snap.classes.map((c) => [c.id, c]))

  for (const c of snap.classes) {
    if (c.parentId !== null && !classById.has(c.parentId)) {
      issues.push({
        severity: 'error',
        code: 'CLASS_PARENT_MISSING',
        subject: c.id,
        message: `类 ${c.id} 的父类 ${c.parentId} 不存在`,
      })
    }
  }

  const mark = new Map<string, 'visiting' | 'done'>()
  const reported = new Set<string>()
  const visit = (id: string): void => {
    const st = mark.get(id)
    if (st === 'done') return
    if (st === 'visiting') {
      if (!reported.has(id)) {
        reported.add(id)
        issues.push({
          severity: 'error',
          code: 'CLASS_CYCLE',
          subject: id,
          message: `类继承出现环，经过 ${id}`,
        })
      }
      return
    }
    mark.set(id, 'visiting')
    const parent = classById.get(id)?.parentId ?? null
    if (parent !== null && classById.has(parent)) visit(parent)
    mark.set(id, 'done')
  }
  for (const c of snap.classes) visit(c.id)

  const predicateIds = new Set(snap.predicates.map((p) => p.id))
  const seen = new Set<string>()
  for (const e of snap.edges) {
    if (e.virtual) continue
    // 废止记录行只用于吊销：它的三要素与被吊销边相同，参与重复判定会误报
    if (e.tombstone === true) continue
    if (!snap.nodes.has(e.from) || !snap.nodes.has(e.to)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_ENDPOINT_MISSING',
        subject: e.id,
        message: `边 ${e.id} 指向不存在的节点：${snap.nodes.has(e.from) ? e.to : e.from}`,
      })
    }
    if (!predicateIds.has(e.predicate)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_BAD_PREDICATE',
        subject: e.id,
        message: `边 ${e.id} 使用了未注册的谓词 ${e.predicate}`,
      })
    }
    // 被吊销的边不算重复：吊销后再断言是合法的重新主张
    if (e.retracted === true) continue
    const key = `${e.from}|${e.predicate}|${e.to}|${e.sinceChapter ?? ''}`
    if (seen.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'DUP_EDGE',
        subject: e.id,
        message: `重复边：${e.from} -${e.predicate}-> ${e.to}（同样的 sinceChapter）`,
      })
    } else {
      seen.add(key)
    }
  }

  return issues
}
