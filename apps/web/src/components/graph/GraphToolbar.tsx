import type { GraphLayoutName } from './GraphCanvas'
import { NODE_TYPES, TYPE_LABEL } from './graph-theme'

export interface PredicateOption {
  id: string
  label: string
}

interface Props {
  layout: GraphLayoutName
  onLayout: (name: GraphLayoutName) => void
  search: string
  onSearch: (text: string) => void
  hits: number
  types: ReadonlySet<string>
  onTypes: (next: Set<string>) => void
  predicates: ReadonlySet<string>
  onPredicates: (next: Set<string>) => void
  predicateOptions: PredicateOption[]
  hops: number
  onHops: (n: number) => void
  anchorName: string | null
  /** 类分组框没有可数的邻边，不能当跳数锚点 */
  anchorKind: 'class' | 'instance' | null
  pathFromName: string | null
  pathToName: string | null
  onClearPath: () => void
  highlighted: number
  onClearHighlight: () => void
  onFit: () => void
  onResetPositions: () => void
}

const LAYOUT_LABEL: Record<GraphLayoutName, string> = {
  cose: '力导向',
  breadthfirst: '层级',
  concentric: '同心圆',
  grid: '网格',
  preset: '手动位置',
}

/** 与 TYPE_LABEL 的键保持一致；类节点不参与类型过滤 */

const BTN =
  'rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100'

function chip(active: boolean): string {
  return `rounded border px-1.5 py-0.5 text-[11px] ${
    active
      ? 'border-neutral-900 bg-neutral-900 text-white'
      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-100'
  }`
}

function toggle(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function GraphToolbar(p: Props) {
  return (
    <header className="shrink-0 border-b border-neutral-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-neutral-500">
          布局
          <select
            value={p.layout}
            onChange={(e) => p.onLayout(e.target.value as GraphLayoutName)}
            className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px]"
          >
            {(Object.keys(LAYOUT_LABEL) as GraphLayoutName[])
              .filter((name) => name !== 'preset')
              .map((name) => (
                <option key={name} value={name}>
                  {LAYOUT_LABEL[name]}
                </option>
              ))}
          </select>
        </label>
        <span className="text-[10px] text-neutral-400">切换布局会重置拖拽位置</span>

        <label className="flex items-center gap-1 text-[11px] text-neutral-500">
          <input
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="搜名字 / ID"
            aria-label="搜索节点名"
            className="w-36 rounded border border-neutral-300 px-2 py-0.5 text-[11px] focus:border-neutral-500 focus:outline-none"
          />
          {p.search.trim().length > 0 &&
            (p.hits > 0 ? (
              <span className="text-neutral-400">{p.hits} 个命中</span>
            ) : (
              <span className="text-rose-600">没有匹配</span>
            ))}
        </label>

        <button type="button" onClick={p.onFit} className={BTN}>
          适应视图
        </button>
        <button type="button" onClick={p.onResetPositions} className={BTN}>
          重新布局并清除位置
        </button>
        <div className="ml-auto flex items-center gap-2">
          {p.highlighted > 0 && (
            <span className="text-[11px] text-amber-700">高亮 {p.highlighted} 项</span>
          )}
          <button type="button" onClick={p.onClearHighlight} className={BTN}>
            清除高亮
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[10px] text-neutral-400">类型</span>
        <button
          type="button"
          onClick={() => p.onTypes(new Set())}
          aria-pressed={p.types.size === 0}
          className={chip(p.types.size === 0)}
        >
          全部
        </button>
        {NODE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => p.onTypes(toggle(p.types, t))}
            aria-pressed={p.types.has(t)}
            className={chip(p.types.has(t))}
          >
            {TYPE_LABEL[t] ?? t}
          </button>
        ))}

        <details className="relative">
          <summary className="cursor-pointer text-[11px] text-neutral-500">
            谓词（{p.predicates.size === 0 ? '全部' : p.predicates.size}）
          </summary>
          <div className="absolute z-20 mt-1 max-h-56 w-48 overflow-y-auto rounded border border-neutral-300 bg-white p-1.5 shadow-md">
            <button
              type="button"
              onClick={() => p.onPredicates(new Set())}
              className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-neutral-500 hover:bg-neutral-100"
            >
              全部谓词
            </button>
            {p.predicateOptions.map((o) => (
              <label
                key={o.id}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
              >
                <input
                  type="checkbox"
                  checked={p.predicates.has(o.id)}
                  onChange={() => p.onPredicates(toggle(p.predicates, o.id))}
                />
                {o.label}
              </label>
            ))}
          </div>
        </details>

        <label className="flex items-center gap-1 text-[11px] text-neutral-500">
          只看
          <select
            value={p.hops}
            onChange={(e) => p.onHops(Number(e.target.value))}
            disabled={p.anchorName === null || p.anchorKind === 'class'}
            className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
          >
            <option value={0}>不限</option>
            <option value={1}>1 跳邻居</option>
            <option value={2}>2 跳邻居</option>
            <option value={3}>3 跳邻居</option>
          </select>
        </label>
        <span className="text-[10px] text-neutral-400">
          {p.anchorKind === 'class'
            ? '类分组框不能当锚点，点里面的实例'
            : p.anchorName === null
              ? '先点一个节点作为锚点'
              : `锚点：${p.anchorName}`}
        </span>

        {(p.pathFromName !== null || p.pathToName !== null) && (
          <span className="flex items-center gap-1 text-[11px] text-neutral-600">
            路径：{p.pathFromName ?? '未设起点'} → {p.pathToName ?? '未设终点'}
            <button
              type="button"
              onClick={p.onClearPath}
              className="text-[11px] text-neutral-500 underline decoration-dotted hover:text-neutral-900"
            >
              清除
            </button>
          </span>
        )}
      </div>
    </header>
  )
}
