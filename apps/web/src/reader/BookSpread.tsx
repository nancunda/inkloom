import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import {
  columnCount,
  pageNumbers,
  spreadAfterReflow,
  spreadCount,
  translationFor,
} from './paginate'

/** 页内留白（左右 / 上下）与中缝宽度：单位 px，随字号变化不需要动 */
const PAD_X = 52
const PAD_Y = 44
const GUTTER = 26
/** 一行大约 30 个汉字：17px × 30 ≈ 510px，超过这个宽度读起来会串行 */
const CHARS_PER_LINE = 30
const MIN_COL_W = 240
/** 舞台上下留出的桌面 */
const STAGE_PAD_Y = 18

interface BookSpreadProps {
  /** 左页页眉 */
  bookName: string
  /** 右页页眉 */
  chapterTitle: string
  /** 未定稿：页脚印一个「草稿」点 */
  draft: boolean
  fontSize: number
  /** 当前屏（从 0 开始） */
  spread: number
  /** 重排后由本组件按比例改写屏号 */
  onSpreadChange: (spread: number) => void
  /** 量出来的总屏数 */
  onSpreadsChange: (spreads: number) => void
  /** 章扉页 + 正文段落 + 章末卡片 */
  children: ReactNode
}

/**
 * 双页对开：两页纸并排，正文用 CSS 多栏铺开、靠 translateX 翻屏。
 *
 * ★ 为什么把分页交给浏览器：中文断行涉及标点、引号、拉丁词，自己切一定出错；
 *   column-width + column-fill:auto 让它把整章排成 N 列，我们只负责移动窗口。
 * ★ 量的是 scrollWidth：多栏内容溢出到窗口右侧时，scrollWidth 就是总宽度。
 */
export function BookSpread({
  bookName,
  chapterTitle,
  draft,
  fontSize,
  spread,
  onSpreadChange,
  onSpreadsChange,
  children,
}: BookSpreadProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const flowRef = useRef<HTMLDivElement | null>(null)
  const spreadRef = useRef(spread)
  const spreadsRef = useRef(0)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [columns, setColumns] = useState(0)
  /** 衬线字体晚到时行高会变，量一次之后要再量一次 */
  const [fontTick, setFontTick] = useState(0)

  spreadRef.current = spread

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined) return
      setSize({ w: Math.round(box.width), h: Math.round(box.height) })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    void document.fonts.ready.then(() => setFontTick((n) => n + 1))
  }, [])

  // 可用宽度决定列宽：先按「30 字一行」，放不下就收窄
  const availW = Math.max(0, size.w - 2 * PAD_X * 2 - GUTTER)
  const colW =
    availW <= 0
      ? 0
      : Math.max(MIN_COL_W, Math.min(Math.round(fontSize * CHARS_PER_LINE), Math.floor(availW / 2)))
  const pageW = colW + 2 * PAD_X
  const spreadW = pageW * 2 + GUTTER
  const pageH = Math.max(0, size.h - STAGE_PAD_Y * 2)
  const flowH = Math.max(0, pageH - 2 * PAD_Y)
  // 两页正文之间的间距 = 左右内边距 + 中缝
  const gap = 2 * PAD_X + GUTTER
  const windowW = 2 * colW + gap

  // biome-ignore lint/correctness/useExhaustiveDependencies: 正文与字体不体现在 colW/flowH 上，但会改变列数，必须重测
  useLayoutEffect(() => {
    const flow = flowRef.current
    if (flow === null || colW <= 0 || flowH <= 0) return
    const nextColumns = columnCount(flow.scrollWidth, colW, gap)
    if (nextColumns <= 0) return
    setColumns(nextColumns)
    const next = Math.max(1, spreadCount(nextColumns))
    if (next === spreadsRef.current) return
    const prev = spreadsRef.current
    spreadsRef.current = next
    onSpreadsChange(next)
    // 首次测量（prev === 0）保留外部传入的屏号：那是从 localStorage 还原的位置
    if (prev > 0) onSpreadChange(spreadAfterReflow(spreadRef.current, prev, next))
  }, [colW, flowH, gap, fontSize, fontTick, children, onSpreadChange, onSpreadsChange])

  const pages = pageNumbers(spread, columns)
  const translate = translationFor(spread, colW, gap)
  const ready = spreadW > 0 && pageH > 0

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-4"
      ref={stageRef}
    >
      {ready ? (
        <div
          className="relative shadow-[0_18px_50px_-24px_rgba(70,60,45,0.45)]"
          style={{ width: spreadW, height: pageH }}
        >
          {/* 两张纸 */}
          <div className="reader-page absolute inset-y-0 left-0" style={{ width: pageW }} />
          <div className="reader-page absolute inset-y-0 right-0" style={{ width: pageW }} />
          {/* 中缝：一条很淡的阴影，不做 3D 书脊 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-3 z-10"
            style={{
              left: pageW,
              width: GUTTER,
              background:
                'linear-gradient(90deg, rgba(90,78,60,0.10), rgba(90,78,60,0.02) 45%, rgba(90,78,60,0.10))',
            }}
          />

          {/* 页眉：左书名、右章名 */}
          <div
            className="pointer-events-none absolute top-5 z-10 overflow-hidden whitespace-nowrap text-[10px] tracking-[0.28em] text-paper-faint"
            style={{ left: PAD_X, width: colW }}
          >
            {bookName}
          </div>
          <div
            className="pointer-events-none absolute top-5 z-10 overflow-hidden text-right whitespace-nowrap text-[10px] tracking-[0.28em] text-paper-faint"
            style={{ left: pageW + GUTTER + PAD_X, width: colW }}
          >
            {chapterTitle}
          </div>

          {/* 正文窗口：两页正文宽，超出的列被裁掉，靠 translate 翻 */}
          <div
            className="absolute overflow-hidden"
            style={{
              left: PAD_X,
              top: PAD_Y,
              width: windowW,
              height: flowH,
              fontSize,
              lineHeight: 1.95,
              color: 'var(--color-paper-ink)',
            }}
          >
            <div
              className="reader-flow font-serif"
              ref={flowRef}
              style={
                {
                  '--reader-col-w': `${colW}px`,
                  '--reader-gap': `${gap}px`,
                  '--reader-flow-h': `${flowH}px`,
                  '--reader-window-w': `${windowW}px`,
                  transform: `translateX(${translate}px)`,
                } as React.CSSProperties
              }
            >
              {children}
            </div>
          </div>

          {/* 页脚：外侧页码 + 草稿标记 */}
          <div
            className="pointer-events-none absolute bottom-4 z-10 text-[10px] tracking-[0.2em] text-paper-faint"
            style={{ left: PAD_X, width: colW }}
          >
            {pages.left > 0 ? `— ${pages.left} —` : ''}
            {draft && pages.left > 0 ? <span className="ml-2 text-paper-accent">草稿</span> : null}
          </div>
          <div
            className="pointer-events-none absolute bottom-4 z-10 text-right text-[10px] tracking-[0.2em] text-paper-faint"
            style={{ left: pageW + GUTTER + PAD_X, width: colW }}
          >
            {pages.right > 0 ? `— ${pages.right} —` : ''}
          </div>
        </div>
      ) : null}
    </div>
  )
}
