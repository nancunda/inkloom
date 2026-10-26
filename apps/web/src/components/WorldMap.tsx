import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { useMemo, useState } from 'react'
import '@xyflow/react/dist/style.css'
import { useWorld } from '../api/hooks'

const TYPE_LABEL: Record<string, string> = {
  city: '城镇',
  mountain: '山',
  sect: '宗门',
  secret_realm: '秘境',
  ruin: '遗迹',
  plain: '平原',
}

const TYPE_COLOR: Record<string, string> = {
  city: '#1d4ed8',
  mountain: '#475569',
  sect: '#6d28d9',
  secret_realm: '#0f766e',
  ruin: '#b45309',
  plain: '#15803d',
}

const MODE_LABEL: Record<string, string> = {
  walk: '步行',
  ride: '骑行',
  fly: '飞行',
  teleport: '传送',
  boat: '舟渡',
  caravan: '商队',
}

interface PlaceData extends Record<string, unknown> {
  name: string
  type: string
  region: string
}

function PlaceNodeView({ data }: NodeProps<Node<PlaceData>>) {
  const color = TYPE_COLOR[data.type] ?? '#475569'
  return (
    <div
      className="relative rounded-md border-2 bg-white px-3 py-1.5 text-sm shadow-sm"
      style={{ borderColor: color }}
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
      <span className="font-medium text-neutral-800">{data.name}</span>
      <span className="ml-1.5 text-[10px]" style={{ color }}>
        {TYPE_LABEL[data.type] ?? data.type}
      </span>
      {data.region.length > 0 && (
        <span className="ml-1 text-[10px] text-neutral-400">{data.region}</span>
      )}
    </div>
  )
}

const NODE_TYPES = { place: PlaceNodeView }

/**
 * 世界地图（spec 视图 5）：地点 + 路线。
 *
 * ★ 有坐标用坐标（作者手工摆位），没坐标一律自动圆环——不在前端
 *   "猜"一个看起来像地图的假坐标，那会把作者没表达的空间关系画出来。
 * ★ 传了 onMove 才允许拖：拖完只改本地位置并上报，写盘由调用方决定——
 *   查看地图时不该因为误拖就改了书。
 * ★ 路线标注天数而不是距离：天数才是 P0-13 要求系统算的那个数，
 *   也是写作时真正会引用的数（「走了三天」）。
 */
export function WorldMap({ onMove }: { onMove?: (id: string, x: number, y: number) => void }) {
  const { data, isLoading } = useWorld()
  const [localPos, setLocalPos] = useState<Record<string, { x: number; y: number }>>({})

  const { nodes, edges } = useMemo(() => {
    const locations = data?.locations ?? []
    const routes = data?.routes ?? []

    const hasCoords = locations.some((l) => l.x !== null && l.y !== null)
    const radius = Math.max(170, locations.length * 40)
    const cx = radius + 120
    const cy = radius + 60

    const nodeList: Node<PlaceData>[] = locations.map((l, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, locations.length) - Math.PI / 2
      const auto = {
        x: cx + radius * Math.cos(angle) - 50,
        y: cy + radius * Math.sin(angle) - 20,
      }
      return {
        id: l.id,
        type: 'place',
        position:
          localPos[l.id] ?? (hasCoords && l.x !== null && l.y !== null ? { x: l.x, y: l.y } : auto),
        data: { name: l.name, type: l.type, region: l.region },
      }
    })

    const edgeList: Edge[] = routes.map((r) => ({
      id: r.id,
      source: r.fromId,
      target: r.toId,
      label: `${MODE_LABEL[r.mode] ?? r.mode} ${r.days} 天`,
      labelStyle: { fontSize: 10, fill: '#6b7280' },
      style: {
        stroke: '#94a3b8',
        strokeWidth: 1.5,
        strokeDasharray: r.mode === 'teleport' ? '4 4' : undefined,
      },
      // 单向路线才画箭头（双向画箭头反而误导）
      ...(r.bidirectional ? {} : { markerEnd: { type: MarkerType.ArrowClosed } }),
      ...(r.condition.length > 0 ? { title: r.condition } : {}),
    }))

    return { nodes: nodeList, edges: edgeList }
  }, [data, localPos])

  if (isLoading) return <p className="p-6 text-sm text-neutral-500">读取世界…</p>

  if (nodes.length === 0) {
    return (
      <div className="p-6">
        <p className="text-sm text-neutral-600">这本书还没有登记地点</p>
        <p className="mt-1 text-xs text-neutral-400">
          写 world/locations.json 与 world/routes.json 后这里会出现世界地图
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-600">
        <span>
          {nodes.length} 个地点 · {edges.length} 条路线
        </span>
        <span className="ml-auto text-neutral-400">
          {onMove === undefined
            ? '路线上的天数由系统计算，写作时直接引用'
            : '拖动地点调整位置，松手后点「保存布局」'}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable={onMove !== undefined}
            onNodeDragStop={(_, node) => {
              setLocalPos((p) => ({ ...p, [node.id]: { x: node.position.x, y: node.position.y } }))
              onMove?.(node.id, node.position.x, node.position.y)
            }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}
