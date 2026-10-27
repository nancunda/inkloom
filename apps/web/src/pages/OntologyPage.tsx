import { Background, Controls, type Edge, MarkerType, type Node, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useOntologyGraph, useOntologyNode } from '../api/hooks'
import type {
  OntologyClassRow,
  OntologyDetailData,
  OntologyEdgeRow,
  OntologyNodeRow,
} from '../api/types'
import { type ModuleId, useSessionStore } from '../stores/session'

const TYPE_LABEL: Record<string, string> = {
  character: '人物',
  group: '组织',
  place: '地点',
  rule: '规则',
  item: '物品',
  concept: '概念',
  class: '类',
}

const TYPE_COLOR: Record<string, string> = {
  character: '#1f2937',
  group: '#b45309',
  place: '#0f766e',
  rule: '#be123c',
  item: '#7c3aed',
  concept: '#4b5563',
  class: '#a1a1a1',
}

/** 虚拟节点/边的来源文件 → 该去哪个模块改（spec §5.2 要求给出口） */
const ORIGIN: Record<string, { label: string; module: ModuleId }> = {
  'characters/index.json': { label: '角色卡', module: 'cast' },
  'characters/relations.json': { label: '关系网络', module: 'cast' },
  'world/locations.json': { label: '世界地图', module: 'world' },
  'world/routes.json': { label: '世界地图', module: 'world' },
  'world/rules.json': { label: '世界规则', module: 'world' },
  'story/threads.json': { label: '线索轨迹', module: 'story' },
  'story/arcs.json': { label: '故事弧', module: 'story' },
}

/** characters/relations.json 的 kind → 中文（虚拟边谓词是 rel:<kind>） */
const REL_LABEL: Record<string, string> = {
  master: '师徒',
  disciple: '弟子',
  kin: '亲族',
  ally: '同盟',
  enemy: '敌对',
  rival: '竞争',
  lover: '情爱',
}

function primaryClass(n: OntologyNodeRow): string {
  // classIds 末尾是最具体的类（基类先入集合），否则作者定义的子类永远被并进父类列
  return n.classIds.at(-1) ?? 'cls-concept'
}

/** 谓词换个中文标签；rel:* 按 kind 映射，未注册的原样输出 */
function predicateLabel(predicate: string, labels: Map<string, string>): string {
  if (predicate.startsWith('rel:')) {
    const kind = predicate.slice(4)
    return REL_LABEL[kind] ?? kind
  }
  return labels.get(predicate) ?? predicate
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

/** 节点详情可能是「类」（instanceOf 的端点），两种情况分开渲染 */
function DetailBody({
  detail,
  classNames,
  nodeNames,
  predicateLabels,
  onGoModule,
}: {
  detail: OntologyDetailData
  classNames: Map<string, string>
  nodeNames: Map<string, string>
  predicateLabels: Map<string, string>
  onGoModule: (module: ModuleId) => void
}) {
  /** 端点名字：服务端给的 > 节点 > 类 > 裸 id（悬空端点只能退回 id） */
  const edgeNameOf = (e: OntologyEdgeRow, side: 'from' | 'to'): string =>
    (side === 'from' ? e.fromName : e.toName) ?? nameOf(side === 'from' ? e.from : e.to)
  const nameOf = (id: string): string => nodeNames.get(id) ?? classNames.get(id) ?? id

  if (detail.node === null) {
    return (
      <div className="space-y-3">
        <div>
          <p className="text-[13px] font-medium text-neutral-900">类「{detail.class.name}」</p>
          <p className="mt-0.5 text-[10px] text-neutral-500">
            {detail.class.id} · {detail.class.instanceCount} 个实例
          </p>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-medium text-neutral-400">实例</p>
          {detail.instances.length === 0 ? (
            <p className="text-[11px] text-neutral-500">还没有节点属于这个类。</p>
          ) : (
            <ul className="space-y-0.5">
              {detail.instances.map((id) => (
                <li key={id} className="text-[11px] leading-5 text-neutral-600">
                  {nameOf(id)}
                </li>
              ))}
            </ul>
          )}
        </div>
        {detail.issues.length > 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800">
            {detail.issues.map((i) => (
              <p key={`${i.code}-${i.subject}`}>{i.message}</p>
            ))}
          </div>
        )}
      </div>
    )
  }

  const node = detail.node
  const origin = node.sourceFile === undefined ? undefined : ORIGIN[node.sourceFile]
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] font-medium text-neutral-900">{node.name}</p>
        <p className="mt-0.5 text-[10px] text-neutral-500">
          {TYPE_LABEL[node.type] ?? node.type} ·{' '}
          {node.virtual ? '虚拟节点（来自原文件）' : '图谱节点'} · {node.id}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-medium text-neutral-400">所属类</p>
        <p className="text-[11px] text-neutral-700">
          {node.classIds.map((id) => classNames.get(id) ?? id).join(' · ') || '未分类'}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-medium text-neutral-400">属性</p>
        {Object.keys(node.attrs).length === 0 ? (
          <p className="text-[11px] text-neutral-500">—</p>
        ) : (
          <ul className="space-y-0.5">
            {Object.entries(node.attrs).map(([k, v]) => (
              <li key={k} className="text-[11px] leading-5 text-neutral-600">
                <span className="text-neutral-400">{k}</span>：{v}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1 text-[10px] font-medium text-neutral-400">
          关系（{detail.edges.length}）
        </p>
        {detail.edges.length === 0 ? (
          <p className="text-[11px] text-neutral-500">这个节点还没有边。</p>
        ) : (
          <ul className="space-y-0.5">
            {detail.edges.map((e: OntologyEdgeRow) => (
              <li key={e.id} className="text-[11px] leading-5 text-neutral-600">
                {e.from === node.id ? '→' : '←'} {predicateLabel(e.predicate, predicateLabels)}{' '}
                {e.from === node.id ? edgeNameOf(e, 'to') : edgeNameOf(e, 'from')}
                {e.sinceChapter === undefined ? '' : ` · 第 ${e.sinceChapter} 章起`}
                {e.retracted === true ? ' · 已废止' : ''}
                {e.virtual ? <span className="ml-1 text-[10px] text-neutral-400">只读</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {node.sourceFile !== undefined && (
        <p className="text-[10px] leading-4 text-neutral-500">
          来源：{origin?.label ?? node.sourceFile}
          {origin !== undefined && (
            <button
              type="button"
              onClick={() => onGoModule(origin.module)}
              className="ml-1 underline decoration-dotted hover:text-neutral-900"
            >
              去「{origin.label}」修改
            </button>
          )}
        </p>
      )}

      {detail.issues.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800">
          {detail.issues.map((i) => (
            <p key={`${i.code}-${i.subject}`}>{i.message}</p>
          ))}
        </div>
      )}
    </div>
  )
}

export function OntologyPage() {
  const [classId, setClassId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const setModule = useSessionStore((s) => s.setModule)

  const { data, isLoading, error } = useOntologyGraph({
    classId: classId ?? undefined,
    q,
    issuesOnly,
  })
  const detail = useOntologyNode(selected)

  // 换了筛选后，右栏不能还停在一个已经不在画布上的节点
  useEffect(() => {
    if (selected === null || data === undefined) return
    if (!data.nodes.some((n) => n.id === selected)) setSelected(null)
  }, [data, selected])

  const classNames = useMemo(
    () => new Map((data?.classes ?? []).map((c) => [c.id, c.name])),
    [data],
  )
  const nodeNames = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n.name])), [data])
  const predicateLabels = useMemo(
    () => new Map((data?.predicates ?? []).map((p) => [p.id, p.label])),
    [data],
  )

  const flow = useMemo(() => {
    if (data === undefined) return { nodes: [] as Node[], edges: [] as Edge[] }
    // 只给「真的有实例」的类留列，否则空类会把画布拉成一长条空白
    const columns: string[] = []
    const rows = new Map<string, number>()
    const nodes: Node[] = data.nodes.map((n) => {
      const cls = primaryClass(n)
      let col = columns.indexOf(cls)
      if (col === -1) {
        columns.push(cls)
        col = columns.length - 1
      }
      const rowIndex = rows.get(cls) ?? 0
      rows.set(cls, rowIndex + 1)
      return {
        id: n.id,
        position: { x: 40 + col * 190, y: 60 + rowIndex * 64 },
        data: { label: n.name },
        style: {
          width: 120,
          padding: 6,
          fontSize: 11,
          borderRadius: 8,
          background: '#fff',
          color: '#262626',
          border: `${n.virtual ? 1 : 2}px solid ${TYPE_COLOR[n.type] ?? '#737373'}`,
        },
      }
    })
    // 列标题：不然作者只能猜这四列凭什么是这四列
    const headers: Node[] = columns.map((cls, col) => ({
      id: `col-${cls}`,
      position: { x: 40 + col * 190, y: 10 },
      data: { label: classNames.get(cls) ?? cls },
      draggable: false,
      selectable: false,
      style: {
        width: 120,
        border: 'none',
        background: 'transparent',
        fontSize: 10,
        color: '#737373',
      },
    }))
    // 画布只画两端都是节点的边；指向类 id 的 instanceOf 在右栏关系里看
    const drawn = new Set(nodes.map((n) => n.id))
    const edges: Edge[] = data.edges
      .filter((e) => drawn.has(e.from) && drawn.has(e.to))
      .map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: predicateLabel(e.predicate, predicateLabels),
        style: {
          stroke: e.virtual ? '#d4d4d4' : '#8a8a8a',
          strokeDasharray: e.retracted === true ? '2 4' : undefined,
        },
        labelStyle: { fontSize: 9, fill: '#737373' },
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
        labelBgPadding: [2, 1] as [number, number],
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      }))
    return { nodes: [...headers, ...nodes], edges }
  }, [data, predicateLabels, classNames])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    setQ(draft.trim())
  }

  return (
    <div className="flex h-full min-h-0 w-full bg-white">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
        <div className="border-b border-neutral-200 px-3 py-3">
          <h1 className="text-sm font-semibold text-neutral-900">图谱</h1>
          <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
            类—实例—边；人物/地点/规则是自动聚合的虚拟节点。
          </p>
          <form onSubmit={submit} className="mt-2 flex gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="搜节点名"
              aria-label="搜索节点名"
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-[11px] focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="submit"
              className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
            >
              搜
            </button>
          </form>
          <label className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
            <input
              type="checkbox"
              checked={issuesOnly}
              onChange={(e) => setIssuesOnly(e.target.checked)}
            />
            只看有问题的节点
          </label>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          {data === undefined ? (
            <p className="px-1 text-[11px] text-neutral-400">读取类表…</p>
          ) : (
            <ClassTree classes={data.classes} active={classId} onPick={setClassId} />
          )}
        </div>
        <div className="border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
          {data === undefined
            ? '—'
            : `${data.nodes.length}/${data.total} 节点 · ${data.edges.length} 边 · ${data.issues.length} 问题`}
          {data?.truncated === true && (
            <p className="text-amber-700">
              节点太多，只画了前 {data.nodes.length} 个；用类或搜索缩小范围
            </p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 px-4 py-2">
          <p className="text-[12px] text-neutral-500">
            {q.length > 0
              ? `搜索「${q}」`
              : classId === null
                ? '全部节点'
                : (classNames.get(classId) ?? classId)}
          </p>
          {q.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQ('')
                setDraft('')
              }}
              className="text-[11px] text-neutral-500 hover:text-neutral-900"
            >
              清除搜索
            </button>
          )}
          {(classId !== null || issuesOnly) && (
            <button
              type="button"
              onClick={() => {
                setClassId(null)
                setIssuesOnly(false)
              }}
              className="text-[11px] text-neutral-500 hover:text-neutral-900"
            >
              清除筛选
            </button>
          )}
          <p className="ml-auto text-[10px] text-neutral-400">实线=已入图 · 浅色=既有数据投影</p>
        </header>

        <div className="relative min-h-0 flex-1">
          {isLoading && <p className="p-6 text-sm text-neutral-500">构建图谱…</p>}
          {error !== null && <p className="p-6 text-sm text-rose-700">{error.message}</p>}
          {data !== undefined && data.nodes.length === 0 && (
            <div className="p-6">
              {q === '' && classId === null && !issuesOnly ? (
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
                      setQ('')
                      setDraft('')
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
          {data !== undefined && data.nodes.length > 0 && (
            <ReactFlow
              key={`${data.signature}-${classId ?? 'all'}-${q}-${issuesOnly ? 'i' : ''}`}
              defaultNodes={flow.nodes}
              defaultEdges={flow.edges}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, node) => {
                if (node.id.startsWith('col-')) return
                setSelected(node.id)
              }}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.3}
              maxZoom={1.4}
            >
              <Background gap={16} color="#e5e5e5" />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
          )}
          {data !== undefined && (data.warnings.length > 0 || data.issues.length > 0) && (
            <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-col gap-1">
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
        <div className="border-b border-neutral-200 px-4 py-3">
          <p className="text-[11px] font-medium text-neutral-500">节点详情</p>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {selected === null ? (
            <p className="text-[11px] leading-5 text-neutral-500">
              点画布上的节点查看属性、关系与来源。
            </p>
          ) : detail.data === undefined ? (
            <p className="text-[11px] text-neutral-400">
              {detail.isLoading ? '读取…' : '没有数据'}
            </p>
          ) : (
            <DetailBody
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
