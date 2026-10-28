import type { OntologyDetailData, OntologyEdgeRow } from '../../api/types'
import type { ModuleId } from '../../stores/session'
import { predicateLabel, TYPE_LABEL } from './graph-theme'

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

/** 节点详情可能是「类」（instanceOf 的端点），两种情况分开渲染 */
export function GraphDetail({
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
  const nameOf = (id: string): string => nodeNames.get(id) ?? classNames.get(id) ?? id
  const edgeNameOf = (e: OntologyEdgeRow, side: 'from' | 'to'): string =>
    (side === 'from' ? e.fromName : e.toName) ?? nameOf(side === 'from' ? e.from : e.to)

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
            {detail.edges.map((e) => (
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
