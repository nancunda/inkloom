import { useEffect, useMemo, useRef, useState } from 'react'
import { useBook, useOntologyGraph, useOntologyNode, useOntologyPath } from '../api/hooks'
import {
  GraphCanvas,
  type GraphCanvasHandle,
  type GraphLayoutName,
} from '../components/graph/GraphCanvas'
import { GraphDetail } from '../components/graph/GraphDetail'
import { GraphLegend } from '../components/graph/GraphLegend'
import { GraphPathPanel } from '../components/graph/GraphPathPanel'
import { GraphSidebar } from '../components/graph/GraphSidebar'
import { GraphToolbar } from '../components/graph/GraphToolbar'
import { useGraphLayout } from '../components/graph/useGraphLayout'
import {
  filterElements,
  inducedIds,
  nodesWithinHops,
  searchNodes,
  toGraphElements,
} from '../lib/graph-elements'
import { useSessionStore } from '../stores/session'

interface ContextMenu {
  id: string
  x: number
  y: number
}

export function OntologyPage() {
  const [classId, setClassId] = useState<string | null>(null)
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [layout, setLayout] = useState<GraphLayoutName>('cose')
  const [types, setTypes] = useState<Set<string>>(new Set())
  const [predicates, setPredicates] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [hops, setHops] = useState(0)
  const [pathFrom, setPathFrom] = useState<string | null>(null)
  const [pathTo, setPathTo] = useState<string | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const canvasRef = useRef<GraphCanvasHandle | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const setModule = useSessionStore((s) => s.setModule)

  const { data: book } = useBook()
  const { data, isLoading, error } = useOntologyGraph({
    classId: classId ?? undefined,
    issuesOnly,
  })
  const detail = useOntologyNode(selected)
  const path = useOntologyPath(pathFrom, pathTo)

  const base = useMemo(
    () => (data === undefined ? { nodes: [], edges: [] } : toGraphElements(data)),
    [data],
  )
  const filtered = useMemo(
    () => filterElements(base, { nodeTypes: types, predicates }),
    [base, types, predicates],
  )

  const classNames = useMemo(
    () => new Map((data?.classes ?? []).map((c) => [c.id, c.name])),
    [data],
  )
  const nodeNames = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n.name])), [data])
  const predicateLabels = useMemo(
    () => new Map((data?.predicates ?? []).map((p) => [p.id, p.label])),
    [data],
  )
  const predicateOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of base.edges) seen.set(e.data.predicate, e.data.label)
    return [...seen]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  }, [base])

  const { preset, save, clear } = useGraphLayout(book?.id ?? 'none', data?.signature ?? 'none')

  /** 详情栏/工具栏都要显示名字：节点优先，类其次，兜底 id */
  const nameOf = (id: string | null): string =>
    id === null ? '—' : (nodeNames.get(id) ?? classNames.get(id) ?? id)

  // 换了筛选后，右栏与右键菜单都不能还停在一个已经不在画布上的节点
  useEffect(() => {
    if (data === undefined) return
    if (selected !== null && !filtered.nodes.some((n) => n.data.id === selected)) setSelected(null)
    if (menu !== null && !filtered.nodes.some((n) => n.data.id === menu.id)) setMenu(null)
  }, [filtered, selected, menu, data])

  // 菜单不只靠点画布关闭：Esc 与点外面都收
  useEffect(() => {
    if (menu === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    const onPointer = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [menu])

  const hits = useMemo(() => searchNodes(filtered, search), [filtered, search])

  useEffect(() => {
    if (hits[0] !== undefined) canvasRef.current?.focus(hits[0])
  }, [hits])

  // 高亮优先级：路径 > 搜索 > N 跳邻居；都没有就不高亮
  const highlightNodes = useMemo<Set<string> | null>(() => {
    const found = path.data
    if (found?.found === true) return new Set(found.nodes.map((n) => n.id))
    if (hits.length > 0) return new Set(hits)
    if (selected !== null && hops > 0) return nodesWithinHops(filtered, selected, hops)
    return null
  }, [path.data, hits, selected, hops, filtered])

  const highlightIds = useMemo(
    () => (highlightNodes === null ? [] : inducedIds(filtered, highlightNodes)),
    [filtered, highlightNodes],
  )

  // 搜索只靠 focus 运镜，高亮不再抢镜头；路径 / N 跳仍需要 fit 到子图
  const highlightFit = path.data?.found === true || (hits.length === 0 && hops > 0)

  // 元素重建会清掉 class，画布自己会重放；这里只负责高亮集合变化
  useEffect(() => {
    const handle = canvasRef.current
    if (handle === null) return
    if (highlightIds.length > 0) handle.highlight(highlightIds, highlightFit)
    else handle.resetHighlight()
  }, [highlightIds, highlightFit])

  const changeLayout = (name: GraphLayoutName): void => {
    setLayout(name)
    canvasRef.current?.runLayout(name)
  }

  const clearHighlight = (): void => {
    setSearch('')
    setHops(0)
    setPathFrom(null)
    setPathTo(null)
  }

  const resetPositions = (): void => {
    clear()
    canvasRef.current?.runLayout(layout === 'preset' ? 'cose' : layout)
  }

  // 类节点不是图里的实体：既不能作路径端点，也没法当 N 跳锚点
  const menuKind =
    menu === null ? undefined : filtered.nodes.find((n) => n.data.id === menu.id)?.data.kind
  const anchorKind =
    selected === null
      ? null
      : (filtered.nodes.find((n) => n.data.id === selected)?.data.kind ?? null)

  return (
    <div className="flex h-full min-h-0 w-full bg-white">
      <GraphSidebar
        classes={data?.classes ?? []}
        active={classId}
        onPick={setClassId}
        issuesOnly={issuesOnly}
        onIssuesOnly={setIssuesOnly}
        loading={data === undefined}
        stats={{
          nodes: data?.nodes.length ?? 0,
          total: data?.total ?? 0,
          edges: data?.edges.length ?? 0,
          issues: data?.issues.length ?? 0,
          truncated: data?.truncated === true,
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <GraphToolbar
          layout={layout}
          onLayout={changeLayout}
          search={search}
          onSearch={setSearch}
          hits={hits.length}
          types={types}
          onTypes={setTypes}
          predicates={predicates}
          onPredicates={setPredicates}
          predicateOptions={predicateOptions}
          hops={hops}
          onHops={setHops}
          anchorName={selected === null ? null : nameOf(selected)}
          anchorKind={anchorKind}
          pathFromName={pathFrom === null ? null : nameOf(pathFrom)}
          pathToName={pathTo === null ? null : nameOf(pathTo)}
          onClearPath={() => {
            setPathFrom(null)
            setPathTo(null)
          }}
          highlighted={highlightIds.length}
          onClearHighlight={clearHighlight}
          onFit={() => canvasRef.current?.fit()}
          onResetPositions={resetPositions}
        />

        <div ref={stageRef} className="relative min-h-0 flex-1">
          {isLoading && <p className="p-6 text-sm text-neutral-500">构建图谱…</p>}
          {error !== null && <p className="p-6 text-sm text-rose-700">{error.message}</p>}

          {data !== undefined && filtered.nodes.length === 0 && (
            <div className="p-6">
              {data.nodes.length === 0 ? (
                <>
                  <p className="text-sm text-neutral-600">这本书还没有入图的实体。</p>
                  <p className="mt-2 text-[11px] leading-5 text-neutral-500">
                    图谱由现有实体自动生成：先去「角色 / 世界 /
                    故事」建内容，这里就会出现人物、地点、规则节点。
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-neutral-600">当前筛选下没有节点。</p>
                  <button
                    type="button"
                    onClick={() => {
                      setTypes(new Set())
                      setPredicates(new Set())
                      setSearch('')
                      setClassId(null)
                      setIssuesOnly(false)
                    }}
                    className="mt-2 rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
                  >
                    清除全部筛选
                  </button>
                </>
              )}
            </div>
          )}

          {data !== undefined && filtered.nodes.length > 0 && (
            <>
              <GraphCanvas
                ref={canvasRef}
                elements={filtered}
                layout={layout}
                signature={data.signature}
                preset={preset}
                onSelect={(id) => {
                  setSelected(id)
                  setMenu(null)
                }}
                onContext={(id, at) => {
                  // 菜单宽 176、高约 132：贴边时向内钳制，不要盖到右栏
                  const w = stageRef.current?.clientWidth ?? 0
                  const h = stageRef.current?.clientHeight ?? 0
                  setMenu({
                    id,
                    x: Math.max(0, Math.min(at.x, w - 184)),
                    y: Math.max(0, Math.min(at.y, h - 132)),
                  })
                }}
                onPositions={save}
              />
              <GraphLegend />
              {menu !== null && (
                <div
                  ref={menuRef}
                  className="absolute z-10 w-44 rounded border border-neutral-300 bg-white py-1 text-[11px] shadow-md"
                  style={{ left: menu.x, top: menu.y }}
                >
                  <p className="truncate px-2 py-1 text-[10px] text-neutral-400">
                    {nameOf(menu.id)}
                  </p>
                  {menuKind !== 'class' && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setPathFrom(menu.id)
                          if (pathTo === menu.id) setPathTo(null)
                          setMenu(null)
                        }}
                        className="block w-full px-2 py-1 text-left text-neutral-700 hover:bg-neutral-100"
                      >
                        设为路径起点
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPathTo(menu.id)
                          if (pathFrom === menu.id) setPathFrom(null)
                          setMenu(null)
                        }}
                        className="block w-full px-2 py-1 text-left text-neutral-700 hover:bg-neutral-100"
                      >
                        设为路径终点
                      </button>
                    </>
                  )}
                  {menuKind === 'class' && (
                    <p className="px-2 py-1 text-[10px] text-neutral-400">类节点不能作为路径端点</p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(menu.id)
                      setMenu(null)
                    }}
                    className="block w-full px-2 py-1 text-left text-neutral-700 hover:bg-neutral-100"
                  >
                    查看详情
                  </button>
                </div>
              )}
            </>
          )}

          {data !== undefined && (data.warnings.length > 0 || data.issues.length > 0) && (
            <div className="pointer-events-none absolute right-2 top-2 flex w-80 flex-col gap-1">
              {data.warnings.length > 0 && (
                <div className="pointer-events-auto rounded border border-neutral-300 bg-white/95 px-3 py-2 text-[11px] leading-5 text-neutral-700">
                  {data.warnings.slice(0, 3).map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                  {data.warnings.length > 3 && <p>另有 {data.warnings.length - 3} 条</p>}
                </div>
              )}
              {data.issues.length > 0 && (
                <div className="pointer-events-auto rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  {data.issues.slice(0, 3).map((i) => (
                    <p key={`${i.code}-${i.subject}`}>
                      [{i.code}] {i.message}
                    </p>
                  ))}
                  {data.issues.length > 3 && <p>另有 {data.issues.length - 3} 条问题</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/60">
        {pathFrom !== null && pathTo !== null && (
          <GraphPathPanel
            fromName={nameOf(pathFrom)}
            toName={nameOf(pathTo)}
            path={path.data}
            loading={path.isLoading}
            error={path.error === null ? null : path.error.message}
            predicateLabels={predicateLabels}
            onClear={() => {
              setPathFrom(null)
              setPathTo(null)
            }}
          />
        )}
        <div className="border-b border-neutral-200 px-4 py-3">
          <p className="text-[11px] font-medium text-neutral-500">节点详情</p>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {selected === null ? (
            <p className="text-[11px] leading-5 text-neutral-500">
              点画布上的节点查看属性、关系与来源；右键节点可设路径起终点。
            </p>
          ) : detail.data === undefined ? (
            <p className="text-[11px] text-neutral-400">
              {detail.isLoading ? '读取…' : '没有数据'}
            </p>
          ) : (
            <GraphDetail
              detail={detail.data}
              classNames={classNames}
              nodeNames={nodeNames}
              predicateLabels={predicateLabels}
              onGoModule={setModule}
            />
          )}
        </div>
      </aside>
    </div>
  )
}
