import { useLibrary } from './api/hooks'
import { LibraryPage } from './pages/LibraryPage'
import { AppShell } from './shell/AppShell'

/**
 * 应用关卡：先有书，才谈模块。
 *
 * ★ 书库为空是正常状态（新用户第一次启动），不是「连不上 API」。
 * ★ 只有 /api/library 本身失败（API 没起来）才显示连接错误页。
 */
export function App() {
  const { data, error, isLoading } = useLibrary()

  if (isLoading) {
    return <div className="p-8 text-sm text-neutral-500">加载中…</div>
  }

  if (error !== null) {
    return (
      <div className="p-8">
        <h1 className="text-lg font-semibold">连不上 API</h1>
        <p className="mt-2 text-sm text-neutral-600">{error.message}</p>
        <p className="mt-4 text-xs text-neutral-500">启动方式：</p>
        <pre className="mt-1 rounded bg-neutral-100 p-3 text-xs">pnpm api</pre>
        <p className="mt-2 text-xs text-neutral-400">
          便携版：双击 start.bat，浏览器打开 http://127.0.0.1:8787
        </p>
      </div>
    )
  }

  if (data === undefined || data.current === null) {
    return <LibraryPage data={data ?? { libraryRoot: '', current: null, books: [] }} />
  }

  // data 只用来触发「有书」这一关；壳里每个模块自己取数
  return <AppShell />
}
