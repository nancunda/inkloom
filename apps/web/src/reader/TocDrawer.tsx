import { useEffect, useRef } from 'react'

export interface TocChapter {
  chapterNo: number
  title: string | null
  wordCount: number
  status: string
}

interface TocDrawerProps {
  open: boolean
  chapters: TocChapter[]
  current: number
  onPick: (chapterNo: number) => void
  onClose: () => void
}

const STATUS_DOT: Record<string, string> = {
  finalized: 'bg-paper-accent',
  drafting: 'bg-paper-faint',
  planned: 'bg-paper-rule',
}

function statusText(status: string, wordCount: number): string {
  if (status === 'finalized')
    return wordCount > 0 ? `定稿 · ${wordCount.toLocaleString()} 字` : '定稿'
  // 有候选稿的章在索引里可能还是 0 字（没接受过），不能当成「未写」
  if (status === 'drafting')
    return wordCount > 0 ? `草稿 · ${wordCount.toLocaleString()} 字` : '草稿'
  if (wordCount > 0) return `${wordCount.toLocaleString()} 字`
  return '未写'
}

/**
 * 目录抽屉：书面左侧抽出的一页目录。
 * ★ 只做「选章」，不做搜索与排序——章节顺序就是书的顺序。
 */
export function TocDrawer({ open, chapters, current, onPick, onClose }: TocDrawerProps) {
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const active = list?.querySelector<HTMLButtonElement>('[data-current="true"]')
    const first = list?.querySelector<HTMLButtonElement>('button')
    ;(active ?? first)?.focus()
  }, [open])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    e.preventDefault()
    const next = buttons[e.key === 'ArrowDown' ? index + 1 : index - 1]
    next?.focus()
  }

  return (
    <div
      className="absolute inset-0 z-30 flex"
      role="dialog"
      aria-modal="true"
      aria-label="目录"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-label="关闭目录"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[rgba(43,39,35,0.18)]"
      />
      <section className="relative flex w-[min(300px,86vw)] flex-col border-r border-paper-rule bg-paper shadow-[12px_0_40px_-24px_rgba(70,60,45,0.5)]">
        <header className="flex items-baseline justify-between border-b border-paper-rule px-5 py-4">
          <h2 className="font-serif text-[13px] tracking-[0.3em] text-paper-ink">目 录</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] text-paper-faint hover:text-paper-ink"
          >
            关闭 Esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto py-2" ref={listRef}>
          {chapters.length === 0 ? (
            <p className="px-5 py-6 text-[12px] text-paper-muted">这本书还没有章节。</p>
          ) : (
            chapters.map((c) => {
              const active = c.chapterNo === current
              return (
                <button
                  key={c.chapterNo}
                  type="button"
                  data-current={active ? 'true' : 'false'}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onPick(c.chapterNo)}
                  className={`flex w-full items-baseline gap-3 px-5 py-2 text-left ${
                    active ? 'bg-[rgba(63,93,75,0.08)]' : 'hover:bg-[rgba(63,93,75,0.04)]'
                  }`}
                >
                  <span
                    className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                      STATUS_DOT[c.status] ?? 'bg-paper-rule'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[13px] ${
                        active ? 'font-medium text-paper-accent' : 'text-paper-ink'
                      }`}
                    >
                      {c.title ?? `第 ${c.chapterNo} 章`}
                    </span>
                    <span className="mt-0.5 block text-[10px] tracking-wide text-paper-faint">
                      第 {c.chapterNo} 章 · {statusText(c.status, c.wordCount)}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
        <footer className="border-t border-paper-rule px-5 py-3 text-[10px] leading-5 text-paper-faint">
          ↑↓ 选择 · Enter 打开
          <br />c 开关目录 · f 沉浸
        </footer>
      </section>
    </div>
  )
}
