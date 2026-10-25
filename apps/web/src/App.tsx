import { useEffect, useMemo } from 'react'
import { useBook } from './api/hooks'
import { type Command, CommandPalette } from './components/CommandPalette'
import { STATUS_LABEL } from './lib/status'
import { WritingPage } from './pages/WritingPage'
import { useSessionStore } from './stores/session'

/** 顶部视图切换。放在 header 里，地图视图下也能一键切回来 */
function ViewTabs() {
  const view = useSessionStore((s) => s.view)
  const setView = useSessionStore((s) => s.setView)
  return (
    <nav className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5">
      {(['write', 'map'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          className={`rounded px-2.5 py-1 text-xs ${
            view === v ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500'
          }`}
        >
          {v === 'write' ? '写作' : '地图'}
        </button>
      ))}
    </nav>
  )
}

export function App() {
  const { data, error, isLoading } = useBook()
  const palette = useSessionStore((s) => s.palette)
  const setPalette = useSessionStore((s) => s.setPalette)
  const setChapter = useSessionStore((s) => s.setChapter)
  const setView = useSessionStore((s) => s.setView)
  const setFocus = useSessionStore((s) => s.setFocus)

  // Ctrl+K 开关命令面板（spec §4.18）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const s = useSessionStore.getState()
        s.setPalette(!s.palette)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commands: Command[] = useMemo(() => {
    const chapters = (data?.chapters ?? []).map((c) => ({
      id: `ch-${c.chapterNo}`,
      // 标题本身已含「第一章」，前面不要再拼一次「第 1 章」
      label: c.title !== null ? c.title : `第 ${c.chapterNo} 章`,
      hint: `${STATUS_LABEL[c.status] ?? c.status}${c.wordCount > 0 ? ` · ${c.wordCount} 字` : ''}`,
      run: () => {
        setChapter(c.chapterNo)
        setView('write')
      },
    }))
    return [
      ...chapters,
      { id: 'view-write', label: '切到写作视图', run: () => setView('write') },
      { id: 'view-map', label: '切到地图视图', run: () => setView('map') },
      {
        id: 'focus',
        // 用「专注」而不是「纯编辑」：用户心里想的是「专注写作」，
        // 搜「专注」找不到就白做了这个入口。
        label: '进入专注模式（纯编辑）',
        hint: 'Ctrl+Shift+E',
        run: () => setFocus(true),
      },
    ]
  }, [data, setChapter, setView, setFocus])

  if (isLoading) {
    return <div className="p-8 text-sm text-neutral-500">加载中…</div>
  }

  if (error !== null) {
    return (
      <div className="p-8">
        <h1 className="text-lg font-semibold">连不上 API</h1>
        <p className="mt-2 text-sm text-neutral-600">{error.message}</p>
        <p className="mt-4 text-xs text-neutral-500">先在另一个终端启动：</p>
        <pre className="mt-1 rounded bg-neutral-100 p-3 text-xs">
          INKLOOM_BOOK=fixtures/qixia pnpm api
        </pre>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 px-6 py-3">
        <span className="text-lg font-semibold">{data?.name}</span>
        <span className="text-sm text-neutral-500">{data?.genre}</span>
        <span className="ml-auto text-xs text-neutral-400">{data?.chapters.length ?? 0} 章</span>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
          title="命令面板"
        >
          Ctrl+K
        </button>
        <ViewTabs />
      </header>
      <WritingPage />
      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
    </div>
  )
}
