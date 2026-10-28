import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type LayoutOptions,
} from 'cytoscape'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { GraphElements } from '../../lib/graph-elements'
import { GRAPH_STYLE } from './graph-theme'

export type GraphLayoutName = 'cose' | 'breadthfirst' | 'concentric' | 'grid' | 'preset'

export interface GraphCanvasHandle {
  fit(): void
  runLayout(name: GraphLayoutName): void
  focus(id: string): void
  highlight(ids: string[], fit?: boolean): void
  resetHighlight(): void
  positions(): Record<string, { x: number; y: number }>
}

interface Props {
  elements: GraphElements
  /** ★ layout / preset 只在 elements 变化时应用；运行时换布局请调句柄的 runLayout */
  layout: GraphLayoutName
  /** 书的 content signature：一变就丢本会话坐标与高亮（旧 id 已经没意义） */
  signature?: string
  preset?: Record<string, { x: number; y: number }> | undefined
  onSelect: (id: string | null) => void
  onContext: (id: string, at: { x: number; y: number }) => void
  onPositions?: (positions: Record<string, { x: number; y: number }>) => void
}

const LAYOUTS: Record<Exclude<GraphLayoutName, 'preset'>, LayoutOptions> = {
  cose: {
    name: 'cose',
    animate: false,
    fit: true,
    padding: 36,
    nodeRepulsion: () => 12000,
    idealEdgeLength: () => 100,
  } as LayoutOptions,
  breadthfirst: {
    name: 'breadthfirst',
    directed: true,
    animate: false,
    padding: 36,
    spacingFactor: 1.1,
  },
  concentric: {
    name: 'concentric',
    animate: false,
    padding: 36,
    levelWidth: () => 2,
  },
  grid: { name: 'grid', animate: false, padding: 36 },
}

function elementDefs(elements: GraphElements): ElementDefinition[] {
  // ★ 复合节点必须先有 parent：类在前、实例在后、边最后
  const classNodes = elements.nodes.filter((n) => n.data.kind === 'class')
  const instances = elements.nodes.filter((n) => n.data.kind === 'instance')
  return [
    ...classNodes.map((n) => ({ group: 'nodes' as const, data: n.data })),
    ...instances.map((n) => ({ group: 'nodes' as const, data: n.data })),
    ...elements.edges.map((e) => ({ group: 'edges' as const, data: { ...e.data } })),
  ]
}

function positionsOf(cy: Core): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  cy.nodes().forEach((n) => {
    out[n.id()] = { x: n.position('x'), y: n.position('y') }
  })
  return out
}

function applyLayout(cy: Core, name: GraphLayoutName, onStop?: () => void): void {
  if (name === 'preset') return
  const layout = cy.layout(LAYOUTS[name])
  if (onStop !== undefined) layout.one('layoutstop', onStop)
  layout.run()
}

/** 两组 id 是否等价（顺序无关）：页面每次重渲染都会传新数组，靠它避免重复跑动画 */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((id) => set.has(id))
}

/** 压暗全图、高亮命中集合；fit=false 用于元素重建后的静默重放 */
function applyHighlight(cy: Core, ids: string[], fit: boolean): void {
  const picked = cy.collection()
  for (const id of ids) {
    const el = cy.getElementById(id)
    if (!el.empty()) picked.merge(el)
  }
  // ★ 先判空再压暗：否则整图变淡又没有高亮，看起来像「图没了」
  if (picked.length === 0) return
  cy.batch(() => {
    cy.elements().addClass('dimmed').removeClass('hl')
    picked.removeClass('dimmed').addClass('hl')
  })
  if (fit) cy.animate({ fit: { eles: picked, padding: 60 } }, { duration: 200 })
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(
  { elements, layout, signature, preset, onSelect, onContext, onPositions },
  ref,
) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  const cbRef = useRef({ onSelect, onContext, onPositions })
  cbRef.current = { onSelect, onContext, onPositions }
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const presetRef = useRef(preset)
  presetRef.current = preset
  /** 本次会话里已经拖过/布局过的坐标：筛选导致元素重建时用它复位 */
  const posRef = useRef<Record<string, { x: number; y: number }>>({})
  /** 当前高亮集合：元素重建会携 class 一起丢掉，重建后靠它重放 */
  const hlRef = useRef<string[]>([])
  /** 书内容变了：旧坐标与旧高亮都失效，否则新节点会跟旧位置混搭 */
  const sigRef = useRef(signature)
  if (sigRef.current !== signature) {
    sigRef.current = signature
    posRef.current = {}
    hlRef.current = []
  }

  useImperativeHandle(
    ref,
    () => ({
      fit: () => cyRef.current?.fit(undefined, 36),
      runLayout: (name) => {
        const cy = cyRef.current
        if (cy === null) return
        // 用户主动换布局 = 坐标全变：布局完就把新坐标记下来并落盘
        applyLayout(cy, name, () => {
          posRef.current = positionsOf(cy)
          cbRef.current.onPositions?.(posRef.current)
          cy.fit(undefined, 36)
        })
      },
      focus: (id) => {
        const cy = cyRef.current
        if (cy === null) return
        const node = cy.getElementById(id)
        if (node.empty()) return
        // 只动镜头，不 select：选中态由页面管，否则画布选中块与右栏详情对不上
        cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.1) }, { duration: 200 })
      },
      highlight: (ids, fit = true) => {
        // 元素重建由画布自己重放；内容没变就别重启动画，否则敲无命中的搜索也会把视图拽回来
        if (sameIds(ids, hlRef.current)) return
        hlRef.current = ids
        const cy = cyRef.current
        if (cy === null) return
        applyHighlight(cy, ids, fit)
      },
      resetHighlight: () => {
        const cy = cyRef.current
        hlRef.current = []
        if (cy === null) return
        cy.batch(() => {
          cy.elements().removeClass('dimmed').removeClass('hl')
        })
      },
      positions: () => (cyRef.current === null ? {} : positionsOf(cyRef.current)),
    }),
    [],
  )

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return

    const cy = cytoscape({
      container: box,
      style: GRAPH_STYLE,
      wheelSensitivity: 0.2,
      boxSelectionEnabled: true,
      selectionType: 'single',
      elements: [],
    })
    cyRef.current = cy

    cy.on('tap', 'node', (e: EventObject) => {
      cbRef.current.onSelect(e.target.id())
    })
    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) cbRef.current.onSelect(null)
    })
    cy.on('dbltap', 'node', (e: EventObject) => {
      const node = e.target
      if (node.data('kind') === 'class') {
        // 类分组框双击折叠：隐藏/显示所有后代，框自己留下当标题
        const collapsed = node.data('collapsed') === true
        node.data('collapsed', !collapsed)
        node.descendants().style('display', collapsed ? 'element' : 'none')
        return
      }
      cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 200 })
    })
    cy.on('cxttap', 'node', (e: EventObject) => {
      // 用指针位置而不是节点中心：否则菜单正好盖住被点的节点
      cbRef.current.onContext(e.target.id(), e.renderedPosition as { x: number; y: number })
    })
    let saveTimer: number | undefined
    let pending: Record<string, { x: number; y: number }> | undefined
    const flush = (): void => {
      if (pending === undefined) return
      cbRef.current.onPositions?.(pending)
      pending = undefined
    }
    cy.on('dragfree', 'node', () => {
      // ★ 框选多节点拖拽时 cytoscape 逐元素 emit，会回调 K 次；
      //   快照在事件当刻取（元素重建后再取会读到新坐标），只对落盘去抖
      pending = positionsOf(cy)
      posRef.current = pending
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        saveTimer = undefined
        flush()
      }, 150)
    })

    const ro = new ResizeObserver(() => {
      cy.resize()
    })
    ro.observe(box)

    return () => {
      // 卸载前把还没落盘的拖拽补写一次，别让最后一下拖拽丢掉
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
      flush()
      ro.disconnect()
      cy.destroy()
      cyRef.current = null
    }
  }, [])

  useEffect(() => {
    const cy = cyRef.current
    if (cy === null) return
    cy.batch(() => {
      cy.elements().remove()
      cy.add(elementDefs(elements))
    })

    // ★ 过滤只该增减元素，不该把作者拖好的图推倒重来：跑完布局再把已知坐标覆盖回去
    const known = { ...(presetRef.current ?? {}), ...posRef.current }
    const hasKnown = Object.keys(known).length > 0
    applyLayout(cy, layoutRef.current === 'preset' && !hasKnown ? 'cose' : layoutRef.current)
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const p = known[n.id()]
        if (p !== undefined) n.position(p)
      })
    })
    posRef.current = positionsOf(cy)
    cy.fit(undefined, 36)
    // 重建会把 class 一起清掉：把当前高亮静默重放回去（不抢镜头）
    applyHighlight(cy, hlRef.current, false)
  }, [elements])

  return <div ref={boxRef} className="h-full w-full" data-testid="graph-canvas" />
})
