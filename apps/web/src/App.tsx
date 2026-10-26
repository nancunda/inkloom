import { useBook } from './api/hooks'
import { AppShell } from './shell/AppShell'

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
        <p className="mt-4 text-xs text-neutral-500">启动方式：</p>
        <pre className="mt-1 rounded bg-neutral-100 p-3 text-xs">
          INKLOOM_BOOK=./my-novel pnpm api
        </pre>
        <p className="mt-2 text-xs text-neutral-400">
          便携版：双击 start.bat，浏览器打开 http://127.0.0.1:8787
        </p>
      </div>
    )
  }

  // data 只用来触发「书存在」这一关；壳里每个模块自己取数
  void data
  return <AppShell />
}
