import { useBook } from '../api/hooks'
import { STATUS_LABEL, STATUS_MARK } from '../lib/status'
import { useSessionStore } from '../stores/session'

export function ChapterList() {
  const { data } = useBook()
  const chapterNo = useSessionStore((s) => s.chapterNo)
  const setChapter = useSessionStore((s) => s.setChapter)
  const chapters = data?.chapters ?? []

  return (
    <nav className="w-52 shrink-0 overflow-y-auto border-r border-neutral-200 bg-neutral-50">
      <div className="px-3 py-2 text-xs font-medium tracking-wide text-neutral-500">章节</div>
      {chapters.length === 0 && <p className="px-3 py-2 text-xs text-neutral-400">还没有蓝图</p>}
      {chapters.map((c) => {
        const active = c.chapterNo === chapterNo
        return (
          <button
            key={c.chapterNo}
            type="button"
            onClick={() => setChapter(c.chapterNo)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
              active ? 'bg-neutral-900 text-neutral-50' : 'text-neutral-700 hover:bg-neutral-200'
            }`}
          >
            <span className={active ? 'text-neutral-400' : 'text-neutral-400'}>
              {STATUS_MARK[c.status] ?? '·'}
            </span>
            <span className="flex-1 truncate">
              第 {c.chapterNo} 章{c.title === null ? '' : ` ${c.title.replace(/^第.+?章\s*/, '')}`}
            </span>
            <span
              className={`text-xs ${active ? 'text-neutral-400' : 'text-neutral-400'}`}
              title={STATUS_LABEL[c.status] ?? c.status}
            >
              {c.wordCount > 0 ? c.wordCount : ''}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
