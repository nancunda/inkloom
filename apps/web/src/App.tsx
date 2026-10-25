import { useBook } from './api/hooks'
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
        <ViewTabs />
      </header>
      <WritingPage />
    </div>
  )
}
