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
import dagre from 'dagre'
import { useMemo } from 'react'
import '@xyflow/react/dist/style.css'
import { useBlueprints, useBook } from '../api/hooks'
import type { BlueprintLite } from '../api/types'
import { STATUS_LABEL } from '../lib/status'

/** 节点尺寸写死，交给 dagre 算位置——不用测量 DOM，布局一帧到位 */
const NODE_W = 190
const NODE_H = 96

interface ChapterNodeData extends Record<string, unknown> {
  chapterNo: number
  title: string | null
  goal: string
  tensionLevel: number
  /** Chapter 表里的状态；蓝图齐全但还没写 → planned */
  status: string
}

const STATUS_CLS: Record<string, string> = {
  finalized: 'border-neutral-900 bg-white',
  review: 'border-neutral-400 bg-white',
  planned: 'border-dashed border-neutral-300 bg-neutral-50',
}

/**
 * 自定义章节节点。
 *
 * ★ 张力用 5 个小方块而不是数字：一排章节点看过去，
 *   方块填到第几格就是节奏曲线的形状，数字反而要逐个读。
 */
function ChapterNodeView({ data, selected }: NodeProps<Node<ChapterNodeData>>) {
  const { chapterNo, title, goal, tensionLevel, status } = data
  const goalPreview = goal.length > 24 ? `${goal.slice(0, 24)}…` : goal
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      className={`relative flex flex-col rounded-lg border-2 px-3 py-2 shadow-sm transition-shadow ${
        STATUS_CLS[status] ?? STATUS_CLS.planned
      } ${selected === true ? 'ring-2 ring-neutral-900 ring-offset-1' : ''}`}
    >
      {/* ★ 自定义节点必须自己渲染 Handle，否则边找不到挂点（React Flow #008） */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-neutral-400"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-neutral-400"
      />
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-neutral-500">第 {chapterNo} 章</span>
        <span className="text-[10px] text-neutral-400">{STATUS_LABEL[status] ?? status}</span>
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold text-neutral-900">
        {title ?? '（未命名）'}
      </div>
      <div className="mt-0.5 flex-1 truncate text-[11px] text-neutral-500" title={goal}>
        {goalPreview}
      </div>
      <div className="flex items-center gap-1" title={`张力 ${tensionLevel}/5`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`h-1.5 w-4 rounded-sm ${
              i <= tensionLevel ? 'bg-neutral-800' : 'bg-neutral-200'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

const nodeTypes = { chapter: ChapterNodeView }

/**
 * 用 dagre 算横向布局。
 *
 * ★ 为什么不用 React Flow 自带的自动布局：它没有。dagre 是最小的
 *   能算有向图分层的库（约 40 KB），比自己手写力导向省得多。
 */
function layout(
  chapters: BlueprintLite[],
  statusOf: (chapterNo: number) => string,
): { nodes: Node<ChapterNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const c of chapters) {
    g.setNode(String(c.chapterNo), { width: NODE_W, height: NODE_H })
  }
  for (let i = 0; i < chapters.length - 1; i++) {
    const from = chapters[i]
    const to = chapters[i + 1]
    if (from !== undefined && to !== undefined) {
      g.setEdge(String(from.chapterNo), String(to.chapterNo))
    }
  }
  dagre.layout(g)

  const nodes: Node<ChapterNodeData>[] = chapters.map((c) => {
    const p = g.node(String(c.chapterNo)) as { x: number; y: number }
    return {
      id: String(c.chapterNo),
      type: 'chapter',
      // dagre 给的是中心点，React Flow 要左上角
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: {
        chapterNo: c.chapterNo,
        title: c.title,
        goal: c.goal,
        tensionLevel: c.tensionLevel,
        status: statusOf(c.chapterNo),
      },
    }
  })

  const edges: Edge[] = chapters.slice(0, -1).map((c, i) => ({
    id: `e-${c.chapterNo}-${chapters[i + 1]?.chapterNo}`,
    source: String(c.chapterNo),
    target: String(chapters[i + 1]?.chapterNo),
    style: { stroke: '#a3a3a3', strokeWidth: 1.5 },
  }))

  return { nodes, edges }
}

export function StoryMap({ onPick }: { onPick: (chapterNo: number) => void }) {
  const { data: bpData, isLoading: bpLoading } = useBlueprints()
  const { data: book } = useBook()

  const chapters = bpData?.chapters ?? []

  const statusByNo = useMemo(() => {
    const m = new Map<number, string>()
    for (const ch of book?.chapters ?? []) m.set(ch.chapterNo, ch.status)
    return m
  }, [book])

  const { nodes, edges } = useMemo(
    () => layout(chapters, (n) => statusByNo.get(n) ?? 'planned'),
    [chapters, statusByNo],
  )

  if (bpLoading) {
    return <p className="p-8 text-sm text-neutral-500">读取蓝图…</p>
  }

  if (chapters.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
          <p className="text-sm text-neutral-600">还没有蓝图</p>
          <p className="mt-1 text-xs text-neutral-400">蓝图决定章节顺序，先补 story/blueprints/</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-neutral-200 px-6 py-2 text-xs text-neutral-500">
        叙事地图 · {chapters.length} 章 · 点节点跳到该章
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_e, node) => onPick(Number(node.id))}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={20} color="#e5e5e5" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}
