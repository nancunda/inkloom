import { useQueryClient } from '@tanstack/react-query'
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useBook, useChapterText } from '../api/hooks'
import type { ChapterSummary, ChapterText } from '../api/types'
import { BookSpread } from '../reader/BookSpread'
import { clampSpread } from '../reader/paginate'
import { loadReadingPosition, saveReadingPosition } from '../reader/reading-position'
import { type TocChapter, TocDrawer } from '../reader/TocDrawer'
import { useSessionStore } from '../stores/session'

/** 四档字号：15 太小、21 太散，中间两档覆盖大多数屏幕 */
const FONT_STEPS = [15, 17, 19, 21]
const DEFAULT_FONT = 1
const FONT_KEY = 'inkloom.reader.font'
const WIDE = '(min-width: 1180px)'

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 章序号用中文：第一章、第十二章……超过 99 章就直接用数字 */
function cnNumber(n: number): string {
  if (n <= 0 || n > 99) return String(n)
  if (n < 10) return CN_DIGITS[n] ?? String(n)
  if (n === 10) return '十'
  if (n < 20) return `十${CN_DIGITS[n - 10] ?? ''}`
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return `${CN_DIGITS[tens] ?? ''}十${ones === 0 ? '' : (CN_DIGITS[ones] ?? '')}`
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** 章节标题自己就常带「第 X 章」，页眉与扉页里别再重复一遍 */
function stripChapterNo(title: string): string {
  return title
    .replace(/^\s*第\s*[〇零一二三四五六七八九十百千0-9]+\s*章\s*[·:：、.-]?\s*/, '')
    .trim()
}

function displayTitle(title: string | null, chapterNo: number): string {
  const raw = title ?? `第 ${chapterNo} 章`
  const stripped = stripChapterNo(raw)
  return stripped.length > 0 ? stripped : raw
}

function useWideSpread(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE)
    const onChange = (e: MediaQueryListEvent): void => setWide(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

function readFontIndex(): number {
  const raw = window.localStorage.getItem(FONT_KEY)
  const n = raw === null ? Number.NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 && n < FONT_STEPS.length ? n : DEFAULT_FONT
}

/** 阅读器：整页书卷。书壳（目录 / 字库 / 沉浸）在这里，单章排版在 ChapterView。 */
export function ReadPage() {
  const { data: book } = useBook()
  const wide = useWideSpread()
  const setChapter = useSessionStore((s) => s.setChapter)
  const immersive = useSessionStore((s) => s.immersive)
  const setImmersive = useSessionStore((s) => s.setImmersive)

  const chapters = useMemo(
    () => (book?.chapters ?? []).slice().sort((a, b) => a.chapterNo - b.chapterNo),
    [book],
  )

  const [chapterNo, setChapterNo] = useState<number | null>(null)
  /** 只在「还原位置 / 目录跳转」时给 ChapterView 的初始屏号 */
  const [initialSpread, setInitialSpread] = useState(0)
  const [fontIndex, setFontIndex] = useState(readFontIndex)
  const [tocOpen, setTocOpen] = useState(false)
  const restoredFor = useRef<string | null>(null)
  const tocButtonRef = useRef<HTMLButtonElement | null>(null)

  // 首次拿到书：还原上次读到哪一章、第几屏（换书时重新还原）
  useEffect(() => {
    if (book === undefined || chapters.length === 0 || restoredFor.current === book.id) return
    restoredFor.current = book.id
    const saved = loadReadingPosition(window.localStorage, book.id)
    const wanted = saved?.chapterNo ?? useSessionStore.getState().chapterNo
    const byStore = chapters.find((c) => c.chapterNo === wanted)
    const firstReadable = chapters.find((c) => c.wordCount > 0)
    const target = byStore ?? firstReadable ?? chapters[0]
    if (target === undefined) return
    setChapterNo(target.chapterNo)
    setInitialSpread(saved !== null && saved.chapterNo === target.chapterNo ? saved.spread : 0)
  }, [book, chapters])

  const openChapter = useCallback((no: number) => {
    setChapterNo(no)
    setInitialSpread(0)
    setTocOpen(false)
  }, [])

  const toggleFont = useCallback((delta: number) => {
    setFontIndex((idx) => {
      const next = Math.min(Math.max(idx + delta, 0), FONT_STEPS.length - 1)
      window.localStorage.setItem(FONT_KEY, String(next))
      return next
    })
  }, [])

  const goWrite = useCallback(
    (no: number) => {
      setImmersive(false)
      setChapter(no)
    },
    [setChapter, setImmersive],
  )

  const tocChapters: TocChapter[] = chapters.map((c) => ({
    chapterNo: c.chapterNo,
    title: displayTitle(c.title, c.chapterNo),
    wordCount: c.wordCount,
    status: c.status,
  }))

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-paper-desk">
      {book === undefined ? (
        <p className="p-8 text-[12px] text-paper-muted">正在打开书…</p>
      ) : chapters.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="font-serif text-[17px] text-paper-ink">这本书还没有章节</p>
            <p className="mt-2 text-[12px] text-paper-muted">先去写作页生成第一章，再回来读。</p>
            <button
              type="button"
              onClick={() => setChapter(1)}
              className="mt-5 rounded border border-paper-rule px-3 py-1.5 text-[12px] text-paper-ink hover:border-paper-accent hover:text-paper-accent"
            >
              去写作页
            </button>
          </div>
        </div>
      ) : chapterNo === null ? null : (
        <ChapterView
          key={chapterNo}
          bookId={book.id}
          bookName={book.name}
          chapters={chapters}
          chapterNo={chapterNo}
          initialSpread={initialSpread}
          wide={wide}
          fontSize={FONT_STEPS[fontIndex] ?? 17}
          canEnlarge={fontIndex < FONT_STEPS.length - 1}
          canShrink={fontIndex > 0}
          immersive={immersive}
          suspended={tocOpen}
          onFont={toggleFont}
          onTocOpen={() => setTocOpen(true)}
          onImmersive={setImmersive}
          onOpenChapter={openChapter}
          onGoWrite={goWrite}
          tocRef={tocButtonRef}
        />
      )}

      <TocDrawer
        open={tocOpen}
        chapters={tocChapters}
        current={chapterNo ?? 0}
        onPick={openChapter}
        onClose={() => {
          setTocOpen(false)
          tocButtonRef.current?.focus()
        }}
      />
    </div>
  )
}

interface ChapterViewProps {
  bookId: string
  bookName: string
  chapters: ChapterSummary[]
  chapterNo: number
  initialSpread: number
  wide: boolean
  fontSize: number
  canEnlarge: boolean
  canShrink: boolean
  immersive: boolean
  suspended: boolean
  onFont: (delta: number) => void
  onTocOpen: () => void
  onImmersive: (on: boolean) => void
  onOpenChapter: (chapterNo: number) => void
  onGoWrite: (chapterNo: number) => void
  tocRef: RefObject<HTMLButtonElement | null>
}

/** 一章：量页、翻屏、键盘、位置记忆都在这里；换章由外层 key 重新挂载。 */
function ChapterView({
  bookId,
  bookName,
  chapters,
  chapterNo,
  initialSpread,
  wide,
  fontSize,
  canEnlarge,
  canShrink,
  immersive,
  suspended,
  onFont,
  onTocOpen,
  onImmersive,
  onOpenChapter,
  onGoWrite,
  tocRef,
}: ChapterViewProps) {
  const qc = useQueryClient()
  const { data, error, isLoading } = useChapterText(chapterNo)
  const [spread, setSpread] = useState(initialSpread)
  /** 0 = 还没量出来：此时绝不能拿它去卡位置，否则还原会被冲成第一屏 */
  const [spreads, setSpreads] = useState(0)
  const viewSpreads = Math.max(1, spreads)

  const idx = chapters.findIndex((c) => c.chapterNo === chapterNo)
  const meta = idx >= 0 ? chapters[idx] : undefined
  /** 翻到最后 / 最前时自动跨章：按目录顺序走，哪怕下一章还没正文（翻开后是空态） */
  const nextChapter = idx >= 0 ? chapters[idx + 1] : undefined
  const prevChapter = idx > 0 ? chapters[idx - 1] : undefined
  const paragraphs = useMemo(() => paragraphsOf(data?.text ?? ''), [data])
  const draft = meta !== undefined && meta.status !== 'finalized'

  // 位置落盘：换章时 key 重挂，这就是「读到哪」的唯一真相
  useEffect(() => {
    saveReadingPosition(window.localStorage, bookId, { chapterNo, spread })
  }, [bookId, chapterNo, spread])

  // 预取相邻章：翻到下一章不该等一次往返
  useEffect(() => {
    if (idx < 0) return
    for (const c of [chapters[idx + 1], chapters[idx - 1]]) {
      if (c === undefined || c.wordCount === 0) continue
      void qc.prefetchQuery({
        queryKey: ['chapter-text', c.chapterNo],
        queryFn: () => api<ChapterText>(`/chapters/${c.chapterNo}/text`),
      })
    }
  }, [chapters, idx, qc])

  // 量出来的屏数变少时（窗口拉宽 / 字号变小）把屏号收进合法区间。
  // ★ 单页滚动模式下 spread 没有意义（spreads 停在默认的 1），绝不能拿它去卡 0——
  //   否则一进入窄屏就会把记住的位置冲掉。
  useEffect(() => {
    if (!wide || spreads <= 0) return
    setSpread((s) => (s === clampSpread(s, spreads) ? s : clampSpread(s, spreads)))
  }, [spreads, wide])

  const go = useCallback(
    (delta: number) => {
      const next = spread + delta
      if (next < 0) {
        if (prevChapter !== undefined) onOpenChapter(prevChapter.chapterNo)
        return
      }
      if (spreads > 0 && next >= spreads) {
        if (nextChapter !== undefined) onOpenChapter(nextChapter.chapterNo)
        return
      }
      setSpread(next)
    },
    [spread, spreads, prevChapter, nextChapter, onOpenChapter],
  )

  useEffect(() => {
    if (suspended) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target
      if (
        target instanceof HTMLElement &&
        target.closest('input,textarea,select,[contenteditable="true"]') !== null
      ) {
        return
      }
      const onControl = target instanceof HTMLElement && target.closest('button,a') !== null
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault()
          go(1)
          break
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          go(-1)
          break
        case ' ':
          if (onControl) return
          e.preventDefault()
          go(e.shiftKey ? -1 : 1)
          break
        case 'Home':
          e.preventDefault()
          setSpread(0)
          break
        case 'End':
          e.preventDefault()
          setSpread(Math.max(0, viewSpreads - 1))
          break
        case 'c':
        case 'C':
          e.preventDefault()
          onTocOpen()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          onImmersive(!immersive)
          break
        case 'Escape':
          if (immersive) {
            e.preventDefault()
            onImmersive(false)
          }
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, viewSpreads, immersive, suspended, onTocOpen, onImmersive])

  const title = displayTitle(meta?.title ?? null, chapterNo)
  const totalWords = chapters.reduce((n, c) => n + c.wordCount, 0)
  const percent = Math.round(((spread + 1) / Math.max(1, spreads)) * 100)

  return (
    <>
      {immersive ? null : (
        <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-paper-rule bg-paper px-4 py-1.5">
          <button
            type="button"
            ref={tocRef}
            onClick={onTocOpen}
            className="rounded border border-paper-rule px-2 py-1 text-[11px] text-paper-muted hover:border-paper-accent hover:text-paper-accent"
            title="目录（c）"
          >
            ☰ 目录
          </button>
          <span className="min-w-0 truncate font-serif text-[13px] text-paper-ink">{title}</span>
          <span className="hidden shrink-0 text-[10px] tracking-wide text-paper-faint sm:inline">
            第 {cnNumber(chapterNo)} 章{draft ? ' · 草稿' : ''}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="mr-1 hidden text-[10px] tabular-nums text-paper-faint md:inline">
              {wide ? `${percent}% · ` : ''}
              {totalWords.toLocaleString()} 字
            </span>
            <button
              type="button"
              onClick={() => onFont(-1)}
              disabled={!canShrink}
              aria-label="缩小字号"
              className="rounded border border-paper-rule px-2 py-1 text-[11px] text-paper-muted hover:border-paper-accent disabled:opacity-40"
            >
              A−
            </button>
            <button
              type="button"
              onClick={() => onFont(1)}
              disabled={!canEnlarge}
              aria-label="放大字号"
              className="rounded border border-paper-rule px-2 py-1 text-[11px] text-paper-muted hover:border-paper-accent disabled:opacity-40"
            >
              A+
            </button>
            <button
              type="button"
              onClick={() => onImmersive(true)}
              className="hidden rounded border border-paper-rule px-2 py-1 text-[11px] text-paper-muted hover:border-paper-accent sm:inline-flex"
              title="沉浸（f）"
            >
              沉浸
            </button>
            <button
              type="button"
              onClick={() => onGoWrite(chapterNo)}
              className="ml-1 hidden rounded border border-paper-rule px-2 py-1 text-[11px] text-paper-muted hover:border-paper-accent hover:text-paper-accent sm:inline-flex"
            >
              去修改 ↗
            </button>
          </div>
        </header>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 进度细线：像书的书脊，只在不沉浸时出现 */}
        {immersive || !wide ? null : (
          <div className="h-px w-full shrink-0 bg-paper-rule/60">
            <div
              className="h-full bg-paper-accent/35 transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
        {isLoading ? (
          <p className="p-8 text-[12px] text-paper-muted">正在翻开第 {chapterNo} 章…</p>
        ) : wide ? (
          <BookSpread
            bookName={bookName}
            chapterTitle={title}
            draft={draft}
            fontSize={fontSize}
            spread={spread}
            onSpreadChange={setSpread}
            onSpreadsChange={setSpreads}
          >
            <TitlePage chapterNo={chapterNo} title={title} summary={meta?.summary ?? null} />
            {error !== null && paragraphs.length === 0 ? (
              <EmptyChapter onGoWrite={() => onGoWrite(chapterNo)} />
            ) : (
              paragraphs.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 段落列表不重排也不增删，位置就是稳定标识；按文本做键会撞上重复的短句
                <p key={`p${i}`} className="text-justify">
                  {p}
                </p>
              ))
            )}
            <EndCard next={nextChapter ?? null} onOpenChapter={onOpenChapter} />
          </BookSpread>
        ) : (
          <ScrollChapter
            chapterNo={chapterNo}
            title={title}
            summary={meta?.summary ?? null}
            fontSize={fontSize}
            paragraphs={paragraphs}
            empty={error !== null && paragraphs.length === 0}
            next={nextChapter ?? null}
            onOpenChapter={onOpenChapter}
            onGoWrite={() => onGoWrite(chapterNo)}
          />
        )}
      </div>

      {immersive ? null : (
        <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-paper-rule bg-paper px-4 text-[10px] text-paper-faint">
          <span>← → 翻页 · Home / End 首尾 · c 目录 · f 沉浸</span>
          <span className="ml-auto tabular-nums">
            {wide ? `第 ${spread + 1} / ${viewSpreads} 屏` : '单页滚动'}
          </span>
          {!wide ? null : (
            <span className="ml-2 flex items-center gap-1">
              <button
                type="button"
                onClick={() => go(-1)}
                aria-label="上一屏"
                className="rounded px-1.5 py-0.5 text-[12px] leading-none text-paper-muted hover:bg-paper hover:text-paper-accent"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                aria-label="下一屏"
                className="rounded px-1.5 py-0.5 text-[12px] leading-none text-paper-muted hover:bg-paper hover:text-paper-accent"
              >
                ›
              </button>
            </span>
          )}
        </footer>
      )}

      <p className="sr-only" aria-live="polite">
        {title}，第 {spread + 1} 屏，共 {viewSpreads} 屏
      </p>
    </>
  )
}

function TitlePage({
  chapterNo,
  title,
  summary,
}: {
  chapterNo: number
  title: string
  summary: string | null
}) {
  return (
    <section className="reader-titlepage">
      <p className="text-[11px] tracking-[0.5em] text-paper-accent">第 {cnNumber(chapterNo)} 章</p>
      <h2 className="mt-5 font-serif text-[30px] leading-[1.4] tracking-wide text-paper-ink">
        {title}
      </h2>
      <div className="mt-7 h-px w-14 bg-paper-rule" />
      {summary !== null && summary.length > 0 ? (
        <p className="mt-7 max-w-[26em] font-serif text-[12.5px] leading-7 text-paper-muted">
          {summary}
        </p>
      ) : null}
    </section>
  )
}

function EmptyChapter({ onGoWrite }: { onGoWrite: () => void }) {
  return (
    <section className="pt-2">
      <p className="font-serif text-[15px] text-paper-ink">本章尚未成文</p>
      <p className="mt-2 font-serif text-[12.5px] leading-7 text-paper-muted">
        正文还没有被接受，所以这一页是空的。
      </p>
      <button
        type="button"
        onClick={onGoWrite}
        className="mt-4 rounded border border-paper-rule px-3 py-1.5 text-[11px] text-paper-ink hover:border-paper-accent hover:text-paper-accent"
      >
        去写作页 ↗
      </button>
    </section>
  )
}

function EndCard({
  next,
  onOpenChapter,
}: {
  next: ChapterSummary | null
  onOpenChapter: (chapterNo: number) => void
}) {
  return (
    <section style={{ breakInside: 'avoid' }} className="pt-8">
      <div className="border-t border-paper-rule pt-6">
        {next === null ? (
          <p className="font-serif text-[13px] tracking-widest text-paper-muted">— 全书到此 —</p>
        ) : (
          <button
            type="button"
            onClick={() => onOpenChapter(next.chapterNo)}
            className="group text-left"
          >
            <span className="block text-[10px] tracking-[0.3em] text-paper-faint">下一章</span>
            <span className="mt-1 block font-serif text-[16px] text-paper-ink group-hover:text-paper-accent">
              {displayTitle(next.title, next.chapterNo)} →
            </span>
          </button>
        )}
      </div>
    </section>
  )
}

function ScrollChapter({
  chapterNo,
  title,
  summary,
  fontSize,
  paragraphs,
  empty,
  next,
  onOpenChapter,
  onGoWrite,
}: {
  chapterNo: number
  title: string
  summary: string | null
  fontSize: number
  paragraphs: string[]
  empty: boolean
  next: ChapterSummary | null
  onOpenChapter: (chapterNo: number) => void
  onGoWrite: () => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <article
        className="mx-auto max-w-[36em] px-6 py-10 font-serif text-paper-ink"
        style={{ fontSize, lineHeight: 1.95 }}
      >
        <p className="text-center text-[10px] tracking-[0.5em] text-paper-accent">
          第 {cnNumber(chapterNo)} 章
        </p>
        <h2 className="mt-3 text-center text-[24px] leading-snug tracking-wide">{title}</h2>
        <div className="mx-auto mt-5 h-px w-12 bg-paper-rule" />
        {summary !== null && summary.length > 0 ? (
          <p className="mt-6 text-center text-[12px] leading-7 text-paper-muted">{summary}</p>
        ) : null}
        <div className="mt-9">
          {empty ? (
            <div className="text-center">
              <p className="text-[15px]">本章尚未成文</p>
              <button
                type="button"
                onClick={onGoWrite}
                className="mt-4 rounded border border-paper-rule px-3 py-1.5 text-[11px] hover:border-paper-accent hover:text-paper-accent"
              >
                去写作页 ↗
              </button>
            </div>
          ) : (
            paragraphs.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 同上：章内段落不重排
              <p key={`p${i}`} className="mb-4 text-justify indent-[2em]">
                {p}
              </p>
            ))
          )}
        </div>
        <div className="mt-10 border-t border-paper-rule pt-6">
          {next === null ? (
            <p className="text-[13px] tracking-widest text-paper-muted">— 全书到此 —</p>
          ) : (
            <button
              type="button"
              onClick={() => onOpenChapter(next.chapterNo)}
              className="text-left"
            >
              <span className="block text-[10px] tracking-[0.3em] text-paper-faint">下一章</span>
              <span className="mt-1 block text-[16px]">
                {displayTitle(next.title, next.chapterNo)} →
              </span>
            </button>
          )}
        </div>
      </article>
    </div>
  )
}
