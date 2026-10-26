import { useEffect, useState } from 'react'
import { useCheckpoints, useCreateCheckpoint, useRollbackCheckpoint } from '../api/hooks'
import type { CheckpointRow } from '../api/types'

/**
 * 时间机器（spec §2.7 五 / §4.13 回退入口）：检查点列表 + 拍快照 + 回到某一刻。
 *
 * ★ 回退是**不可逆的文件覆盖**，所以必须二次确认，并把「会丢什么」说在前面：
 *   检查点之后的改动只在书内 git 历史里，界面上看不见了。
 * ★ 回退成功后列表里会多一条「回退到…」——不是 bug，是 spec 要求的留痕：
 *   回退本身也是发生过的事，不能被抹掉。
 * ★ 检查点不是备份：它记录的是 git commit + 要素历史行数。真正的数据
 *   永远在文件与 git 里，这里只是「时间坐标」。
 */
export function TimeMachine({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useCheckpoints()
  const create = useCreateCheckpoint()
  const rollback = useRollbackCheckpoint()
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState<CheckpointRow | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = data?.checkpoints ?? []

  const submit = (): void => {
    const l = label.trim()
    if (l === '') return
    setMsg(null)
    create.mutate(l, {
      onSuccess: (r) => {
        setMsg(`已拍下「${r.checkpoint.label}」· ${r.checkpoint.shortRef ?? '无 git 引用'}`)
        setLabel('')
      },
      onError: (e) => setMsg(e.message),
    })
  }

  const confirmRollback = (): void => {
    if (pending === null) return
    setMsg(null)
    rollback.mutate(pending.id, {
      onSuccess: (r) => {
        const warn = [...r.warnings, ...r.reindex.warnings]
        setMsg(
          `已回到「${pending.label}」：恢复 ${r.restoredPaths.length} 个路径，` +
            `截断 ${r.truncatedRevisionFiles.length} 个要素历史` +
            (warn.length > 0 ? ` · ${warn.join('；')}` : ''),
        )
        setPending(null)
      },
      onError: (e) => setMsg(e.message),
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="时间机器"
    >
      <button
        type="button"
        aria-label="关闭时间机器"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-900/20"
      />
      <aside className="relative flex h-full w-[440px] max-w-full flex-col border-l border-neutral-200 bg-white shadow-xl">
        <header className="flex items-baseline gap-2 border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">时间机器</h2>
          <span className="text-[11px] text-neutral-400">检查点 · 回退</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto text-neutral-400 hover:text-neutral-800"
          >
            ×
          </button>
        </header>

        <div className="border-b border-neutral-100 px-4 py-3">
          <label htmlFor="ck-label" className="text-[11px] text-neutral-500">
            拍一个检查点
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="ck-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="例如：第 4 章定稿前"
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-[12px] focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="button"
              disabled={label.trim() === '' || create.isPending}
              onClick={submit}
              className="shrink-0 rounded bg-neutral-900 px-2.5 py-1 text-[11px] text-white disabled:bg-neutral-200 disabled:text-neutral-400"
            >
              {create.isPending ? '提交中…' : '拍下'}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
            提交当前所有文件，并记下每个要素历史的位置。之后随时可以回到这一刻。
          </p>
        </div>

        {msg !== null && (
          <p className="mx-4 mt-3 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] leading-relaxed text-neutral-600">
            {msg}
          </p>
        )}

        {pending !== null && (
          <section className="mx-4 mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] leading-relaxed text-amber-900">
            <p className="font-medium">回到「{pending.label}」会：</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                把 chapters / characters / world / story / styles / novel.json 覆盖成那一刻的样子
              </li>
              <li>把要素历史截断到那一刻（之后的修改记录从「历史」里消失）</li>
              <li>再追加一条「回退到…」的检查点，回退本身不会被抹掉</li>
            </ul>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={rollback.isPending}
                onClick={confirmRollback}
                className="rounded bg-amber-800 px-2.5 py-1 text-[11px] text-white disabled:bg-amber-300"
              >
                {rollback.isPending ? '回退中…' : '确认回退'}
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded border border-amber-300 px-2.5 py-1 text-[11px] text-amber-900"
              >
                取消
              </button>
            </div>
          </section>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && <p className="px-4 py-6 text-[11px] text-neutral-400">读取检查点…</p>}
          <ul className="divide-y divide-neutral-50">
            {rows.map((ck) => (
              <li key={ck.id} className="px-4 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] text-neutral-800">{ck.label}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-neutral-400">
                    {fmtTime(ck.createdAt)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-neutral-400">
                  <code className="text-neutral-500">{ck.shortRef ?? '无 git 引用'}</code>
                  <span>{ck.revisions} 个要素历史</span>
                  <button
                    type="button"
                    onClick={() => {
                      setMsg(null)
                      setPending(ck)
                    }}
                    className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:border-neutral-500"
                  >
                    回到这里
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!isLoading && rows.length === 0 && (
            <p className="px-4 py-8 text-center text-[11px] leading-relaxed text-neutral-400">
              还没有检查点。
              <br />
              重大改动前拍一个，之后就能整本书一起回到此刻。
            </p>
          )}
        </div>

        <footer className="border-t border-neutral-100 px-4 py-2 text-[11px] text-neutral-400">
          CLI 也能用：<code className="text-neutral-500">inkloom checkpoint</code> /{' '}
          <code className="text-neutral-500">inkloom rollback</code>
        </footer>
      </aside>
    </div>
  )
}

/** 本地时间，精确到分钟：检查点是「哪天哪一刻」，秒没有意义 */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
