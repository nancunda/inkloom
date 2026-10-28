import type { OntologyPathData } from '../../api/types'
import { pathHops } from '../../lib/graph-path'
import { predicateLabel } from './graph-theme'

interface Props {
  fromName: string
  toName: string
  path: OntologyPathData | undefined
  loading: boolean
  error: string | null
  predicateLabels: Map<string, string>
  onClear: () => void
}

export function GraphPathPanel({
  fromName,
  toName,
  path,
  loading,
  error,
  predicateLabels,
  onClear,
}: Props) {
  const names = new Map((path?.nodes ?? []).map((n) => [n.id, n.name]))
  const nameOf = (id: string): string => names.get(id) ?? id
  const hops = path === undefined ? [] : pathHops(path.nodes, path.edges)

  return (
    <section className="border-b border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium text-neutral-500">
          路径 · {fromName} → {toName}
        </p>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-900"
        >
          关闭
        </button>
      </div>
      {loading && <p className="mt-1 text-[11px] text-neutral-400">查最短路径…</p>}
      {error !== null && <p className="mt-1 text-[11px] text-rose-700">{error}</p>}
      {path !== undefined &&
        !loading &&
        (path.found ? (
          <ol className="mt-1 space-y-0.5">
            {hops.map((h) => (
              <li
                key={`${h.from}-${h.predicate}-${h.to}`}
                className="text-[11px] leading-5 text-neutral-700"
              >
                {nameOf(h.from)}{' '}
                <span className="text-neutral-400">
                  —{predicateLabel(h.predicate, predicateLabels)}
                  {h.back && !h.undirected ? '（反向）' : ''}→
                </span>{' '}
                {nameOf(h.to)}
                {h.virtual ? <span className="ml-1 text-[10px] text-neutral-400">只读</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-[11px] text-neutral-500">
            最多 4 跳内没有通路；试试放宽类型 / 谓词筛选。
          </p>
        ))}
    </section>
  )
}
