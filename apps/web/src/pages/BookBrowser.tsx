import { useState } from 'react'
import { useCloseLibraryBook, useCreateLibraryBook, useOpenLibraryBook } from '../api/hooks'
import type { LibraryData } from '../api/types'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 书库浏览器：列表 + 新建表单。
 *
 * 页面（空态）与顶栏弹窗（切书）共用同一份交互，避免两处逻辑漂移。
 * 打开/新建成功后整页重载——上一本书的 query 缓存与 runId 不清会串书。
 */
export function BookBrowser({ data }: { data: LibraryData }) {
  const openBook = useOpenLibraryBook()
  const createBook = useCreateLibraryBook()
  const closeBook = useCloseLibraryBook()
  const [creating, setCreating] = useState(data.books.length === 0)
  const [name, setName] = useState('')
  const [genre, setGenre] = useState('玄幻')
  const [totalChapters, setTotalChapters] = useState('12')
  const [wordsPerChapter, setWordsPerChapter] = useState('3000')

  const error = openBook.error ?? createBook.error ?? closeBook.error
  const busy = openBook.isPending || createBook.isPending || closeBook.isPending

  const submit = (): void => {
    const chapters = Number.parseInt(totalChapters, 10)
    const words = Number.parseInt(wordsPerChapter, 10)
    createBook.mutate({
      name: name.trim(),
      genre: genre.trim(),
      ...(Number.isFinite(chapters) && chapters > 0 ? { totalChapters: chapters } : {}),
      ...(Number.isFinite(words) && words > 0 ? { wordsPerChapter: words } : {}),
    })
  }

  return (
    <div className="space-y-4">
      {error !== null && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error.message}
        </div>
      )}

      {data.books.length === 0 ? (
        <p className="text-sm text-neutral-500">
          书库还是空的。新建一本，或把已有的书文件夹整个拷进书库目录后刷新。
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 border-y border-neutral-100">
          {data.books.map((b) => {
            const isCurrent = data.current?.folder === b.folder
            return (
              <li key={b.folder} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-neutral-900">{b.name}</span>
                    <span className="shrink-0 text-xs text-neutral-400">{b.genre}</span>
                    {isCurrent && (
                      <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] text-white">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-neutral-500">
                    {b.totalChapters === null ? '章数未定' : `计划 ${b.totalChapters} 章`}
                    {' · '}
                    最近修改 {formatDate(b.updatedAt)}
                    {' · '}
                    <span className="text-neutral-400">{b.folder}</span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy || isCurrent}
                  onClick={() => openBook.mutate(b.folder)}
                  className="shrink-0 rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isCurrent ? '已打开' : '打开'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {creating ? (
        <div className="space-y-2 rounded border border-neutral-200 p-3">
          <div className="text-xs font-medium text-neutral-700">新建一本书</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 text-xs text-neutral-500">
              书名
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：潮骨"
                className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500"
              />
            </label>
            <label className="text-xs text-neutral-500">
              类型
              <input
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500"
              />
            </label>
            <label className="text-xs text-neutral-500">
              计划章数
              <input
                value={totalChapters}
                onChange={(e) => setTotalChapters(e.target.value)}
                inputMode="numeric"
                className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500"
              />
            </label>
            <label className="text-xs text-neutral-500">
              每章目标字数
              <input
                value={wordsPerChapter}
                onChange={(e) => setWordsPerChapter(e.target.value)}
                inputMode="numeric"
                className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={busy || name.trim().length === 0}
              onClick={submit}
              className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {createBook.isPending ? '创建中…' : '创建并打开'}
            </button>
            {data.books.length > 0 && (
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="text-xs text-neutral-500 hover:text-neutral-800"
              >
                取消
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded border border-dashed border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:border-neutral-500 hover:text-neutral-900"
        >
          + 新建一本书
        </button>
      )}

      {data.current !== null && (
        <div className="flex items-center justify-between border-t border-neutral-100 pt-3 text-xs text-neutral-400">
          <span className="truncate">书库：{data.libraryRoot}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => closeBook.mutate()}
            className="shrink-0 text-neutral-500 hover:text-neutral-900 disabled:opacity-40"
          >
            关闭当前书
          </button>
        </div>
      )}
    </div>
  )
}
