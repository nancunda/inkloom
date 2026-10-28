import type { ReactNode } from 'react'
import type { OntologyClassRow } from '../../api/types'

interface Props {
  classes: OntologyClassRow[]
  active: string | null
  onPick: (id: string | null) => void
  issuesOnly: boolean
  onIssuesOnly: (value: boolean) => void
  /** 图谱数据还没到 vs. 真的一本空书，要分开说 */
  loading: boolean
  stats: { nodes: number; total: number; edges: number; issues: number; truncated: boolean }
}

function ClassTree({
  classes,
  active,
  onPick,
}: {
  classes: OntologyClassRow[]
  active: string | null
  onPick: (id: string | null) => void
}) {
  const byParent = new Map<string | null, OntologyClassRow[]>()
  for (const c of classes) {
    const list = byParent.get(c.parentId) ?? []
    list.push(c)
    byParent.set(c.parentId, list)
  }

  const row = (c: OntologyClassRow, depth: number, key: string): ReactNode => (
    <button
      key={key}
      type="button"
      onClick={() => onPick(active === c.id ? null : c.id)}
      className={`flex w-full items-center rounded px-2 py-1 text-left text-[12px] ${
        active === c.id ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
      }`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="truncate">{c.name}</span>
      <span
        className={`ml-auto shrink-0 text-[10px] ${
          active === c.id ? 'text-neutral-300' : 'text-neutral-400'
        }`}
      >
        {c.instanceCount ?? 0}
      </span>
    </button>
  )

  const render = (parent: string | null, depth: number): ReactNode[] =>
    (byParent.get(parent) ?? []).flatMap((c) => [row(c, depth, c.id), ...render(c.id, depth + 1)])

  // 父类缺失或成环的类进不了树：不能让他俩直接消失（spec §6：图仍可渲染，该分支标红）
  const reachable = new Set<string>()
  const walk = (parent: string | null): void => {
    for (const c of byParent.get(parent) ?? []) {
      if (reachable.has(c.id)) continue
      reachable.add(c.id)
      walk(c.id)
    }
  }
  walk(null)
  const orphans = classes.filter((c) => !reachable.has(c.id))

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => onPick(null)}
        className={`flex w-full items-center rounded px-2 py-1 text-left text-[12px] ${
          active === null ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
        }`}
      >
        全部节点
      </button>
      {render(null, 0)}
      {orphans.length > 0 && (
        <>
          <p className="mt-2 px-2 text-[10px] text-rose-600">孤立类（父类缺失或成环）</p>
          {orphans.map((c) => row(c, 0, c.id))}
        </>
      )}
    </div>
  )
}

export function GraphSidebar({
  classes,
  active,
  onPick,
  issuesOnly,
  onIssuesOnly,
  loading,
  stats,
}: Props) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
      <div className="border-b border-neutral-200 px-3 py-3">
        <h1 className="text-sm font-semibold text-neutral-900">图谱</h1>
        <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
          类—实例—边：同类的实例装进一个分组框，拖动位置会记住。
        </p>
        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
          <input
            type="checkbox"
            checked={issuesOnly}
            onChange={(e) => onIssuesOnly(e.target.checked)}
          />
          只看有问题的节点
        </label>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {loading ? (
          <p className="px-1 text-[11px] text-neutral-400">读取类表…</p>
        ) : classes.length === 0 ? (
          <p className="px-1 text-[11px] text-neutral-400">还没有类。</p>
        ) : (
          <ClassTree classes={classes} active={active} onPick={onPick} />
        )}
      </div>
      <div className="border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
        {stats.total === 0
          ? '—'
          : `${stats.nodes}/${stats.total} 节点 · ${stats.edges} 边 · ${stats.issues} 问题`}
        {stats.truncated && (
          <p className="text-amber-700">
            节点太多，只画了前 {stats.nodes} 个；用类或问题筛选缩小范围
          </p>
        )}
      </div>
    </aside>
  )
}
