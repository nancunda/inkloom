import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { useMemo, useState } from 'react'
import '@xyflow/react/dist/style.css'
import { useBook, useCreateRelation, useRelations } from '../api/hooks'

const KIND_COLOR: Record<string, string> = {
  master: '#b45309',
  disciple: '#b45309',
  kin: '#0f766e',
  ally: '#15803d',
  enemy: '#be123c',
  rival: '#7c3aed',
  lover: '#db2777',
}

const KIND_LABEL: Record<string, string> = {
  master: '师徒',
  disciple: '师徒',
  kin: '亲族',
  ally: '盟友',
  enemy: '敌对',
  rival: '对手',
  lover: '情愫',
}

const ROLE_COLOR: Record<string, string> = {
  protagonist: '#1f2937',
  supporting: '#4b5563',
  antagonist: '#9f1239',
  minor: '#9ca3af',
}

interface CharacterData extends Record<string, unknown> {
  name: string
  role: string
}

/** nodeTypes 必须稳定：每次渲染传新对象会让 React Flow 反复重建节点 */
const NODE_TYPES = { character: CharacterNodeView }

function CharacterNodeView({ data }: NodeProps<Node<CharacterData>>) {
  return (
    <div
      className="relative rounded-full border-2 bg-white px-4 py-2 text-sm shadow-sm"
      style={{ borderColor: ROLE_COLOR[data.role] ?? '#4b5563' }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1 !w-1 !border-0 !bg-neutral-300"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1 !w-1 !border-0 !bg-neutral-300"
      />
      {data.name}
    </div>
  )
}

/**
 * 关系网络（spec 视图 2）。
 *
 * ★ 用圆环布局而不是力导向：角色通常 5–20 个，圆环一眼看清「谁和谁有边」；
 *   力导向每次刷新位置都变，反而难比较。省掉 d3-force 这个依赖。
 * ★ 时间滑块是杀手功能：拖到第 N 章，只留下那时仍然成立的关系
 *   （后端按 sinceChapter / untilChapter 过滤）。
 */
export function RelationGraph() {
  const { data: book } = useBook()
  const maxChapter = book?.chapters.length ?? 0
  const [atChapter, setAtChapter] = useState<number | null>(null)
  const { data, isLoading } = useRelations(atChapter)
  const createRelation = useCreateRelation()

  const [pending, setPending] = useState<{ fromId: string; toId: string } | null>(null)
  const [kind, setKind] = useState('ally')
  const [strength, setStrength] = useState(3)
  const [err, setErr] = useState<string | null>(null)

  const { nodes, edges } = useMemo(() => {
    const list = data?.nodes ?? []
    const rels = data?.edges ?? []
    const radius = Math.max(170, list.length * 34)
    const centerX = radius + 120
    const centerY = radius + 80

    const nodeList: Node<CharacterData>[] = list.map((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, list.length) - Math.PI / 2
      return {
        id: n.id,
        type: 'character',
        position: {
          x: centerX + radius * Math.cos(angle) - 40,
          y: centerY + radius * Math.sin(angle) - 20,
        },
        data: { name: n.name, role: n.role },
      }
    })

    const edgeList: Edge[] = rels.map((r) => ({
      id: r.id,
      source: r.fromId,
      target: r.toId,
      label: `${KIND_LABEL[r.kind] ?? r.kind}${r.strength}/5`,
      animated: r.kind === 'enemy',
      style: { stroke: KIND_COLOR[r.kind] ?? '#9ca3af', strokeWidth: r.strength },
      labelStyle: { fontSize: 10, fill: '#6b7280' },
    }))

    return { nodes: nodeList, edges: edgeList }
  }, [data])

  if (isLoading) return <p className="p-6 text-sm text-neutral-500">读取关系…</p>

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-600">
        <span>时间点</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, maxChapter)}
          value={atChapter ?? 0}
          onChange={(e) => {
            const n = Number(e.target.value)
            setAtChapter(n === 0 ? null : n)
          }}
          className="w-48"
        />
        <span className="w-20 text-neutral-400">
          {atChapter === null ? '全部关系' : `第 ${atChapter} 章`}
        </span>
        <span className="ml-auto text-neutral-400">
          {nodes.length} 角色 · {edges.length} 条关系
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="p-6">
          <p className="text-sm text-neutral-600">这本书还没有角色卡</p>
          <p className="mt-1 text-xs text-neutral-400">
            写 characters/index.json 与 characters/relations.json 后这里会出现关系图
          </p>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {/* ★ 用 absolute 填满：React Flow 需要父容器有确定的宽高（#004），
              flex-1 的百分比高度在某些嵌套下量不到。 */}
          <div className="absolute inset-0">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodesDraggable={false}
              onConnect={(c) => {
                if (c.source !== null && c.target !== null) {
                  setPending({ fromId: c.source, toId: c.target })
                  setErr(null)
                }
              }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </div>
      )}

      {/* 拖两个节点连线的结果表单：spec 视图 2 的「图即操作」 */}
      {pending !== null && (
        <div className="absolute inset-x-0 bottom-4 mx-auto w-80 rounded border border-neutral-300 bg-white p-3 shadow-lg">
          <p className="text-xs font-medium text-neutral-700">建立关系</p>
          <p className="mt-0.5 text-[11px] text-neutral-400">
            {pending.fromId} → {pending.toId}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1 text-xs"
            >
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="range"
              min={1}
              max={5}
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
              className="w-24"
            />
            <span className="text-xs text-neutral-500">强度 {strength}/5</span>
          </div>
          {err !== null && <p className="mt-1 text-[11px] text-rose-600">{err}</p>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={createRelation.isPending}
              onClick={() => {
                void (async () => {
                  try {
                    await createRelation.mutateAsync({
                      fromId: pending.fromId,
                      toId: pending.toId,
                      kind,
                      strength,
                    })
                    setPending(null)
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e))
                  }
                })()
              }}
              className="rounded bg-neutral-900 px-2.5 py-1 text-xs text-white disabled:bg-neutral-300"
            >
              {createRelation.isPending ? '保存中…' : '确认建立'}
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="text-xs text-neutral-500"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
