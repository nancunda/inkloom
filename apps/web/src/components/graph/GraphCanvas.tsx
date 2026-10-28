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
  highlight(ids: string[]): void
  resetHighlight(): void
  positions(): Record<string, { x: number; y: number }>
}

interface Props {
  elements: GraphElements
  /** ★ layout / preset 只在 elements 变化时应用；运行时换布局请调句柄的 runLayout */
  layout: GraphLayoutName
  preset?: Record<string, { x: number; y: number }> | undefined
  onSelect: (id: string | null) => void
  onContext: (id: string) => void
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

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(
  { elements, layout, preset, onSelect, onContext, onPositions },
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

  useImperativeHandle(
    ref,
    () => ({
      fit: () => cyRef.current?.fit(undefined, 36),
      runLayout: (name) => {
        const cy = cyRef.current
        if (cy === null) return
        // 换布局后把全局视野收回来（布局自带 fit 的只有 cose/breadthfirst）
        applyLayout(cy, name, () => cy.fit(undefined, 36))
      },
      focus: (id) => {
        const cy = cyRef.current
        if (cy === null) return
        const node = cy.getElementById(id)
        if (node.empty()) return
        node.select()
        cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.1) }, { duration: 200 })
      },
      highlight: (ids) => {
        const cy = cyRef.current
        if (cy === null) return
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
        cy.animate({ fit: { eles: picked, padding: 60 } }, { duration: 200 })
      },
      resetHighlight: () => {
        const cy = cyRef.current
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
      cy.animate({ center: { eles: e.target }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 200 })
    })
    cy.on('cxttap', 'node', (e: EventObject) => {
      cbRef.current.onContext(e.target.id())
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

    // ★ 先跑布局给新节点占位，再把已知坐标搬回去；顺序反了会把作者的拖拽位置冲掉
    const saved = presetRef.current
    applyLayout(
      cy,
      layoutRef.current === 'preset' && saved === undefined ? 'cose' : layoutRef.current,
    )
    if (saved !== undefined) {
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const p = saved[n.id()]
          if (p !== undefined) n.position(p)
        })
      })
    }
    cy.fit(undefined, 36)
  }, [elements])

  return <div ref={boxRef} className="h-full w-full" data-testid="graph-canvas" />
})
