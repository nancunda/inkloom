import { useEffect } from 'react'
import { useLibrary } from '../api/hooks'
import { BookBrowser } from './BookBrowser'

/** 顶栏「切换书」弹窗：与书库页共用 BookBrowser，交互不分叉 */
export function LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error } = useLibrary()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      {/* 遮罩用 button：点击与键盘都能关闭，避免给静态 div 挂 onClick */}
      <button
        type="button"
        aria-label="关闭书库"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="relative mx-auto mt-16 w-full max-w-xl rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">书库</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-500 hover:text-neutral-900"
          >
            关闭
          </button>
        </div>
        <div className="mt-4">
          {data === undefined ? (
            <p className="text-xs text-neutral-500">{error?.message ?? '加载中…'}</p>
          ) : (
            <BookBrowser data={data} />
          )}
        </div>
      </div>
    </div>
  )
}
