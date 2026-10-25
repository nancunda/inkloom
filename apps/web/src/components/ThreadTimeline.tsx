import { useBook, useThreads } from '../api/hooks'
import type { ThreadRow } from '../api/types'

const KIND_LABEL: Record<string, string> = {
  setup: '埋设',
  payoff: '回收',
  foreshadow: '伏笔',
  callback: '呼应',
  running_gag: '反复梗',
}

const KIND_COLOR: Record<string, string> = {
  setup: '#475569',
  payoff: '#047857',
  foreshadow: '#b45309',
  callback: '#6d28d9',
  running_gag: '#0f766e',
}

/**
 * 线索轨迹（spec 视图 3 的横向部分：伏笔/线索的生命周期）。
 *
 * ★ 一行一条线，横轴是章号：点 = 埋设/推进，绿点 = 回收。
 * ★ 未回收的线**画到右端并断开**——「线断了 = 还没回收」是一眼能看懂的
 *   信号；超过 payoffWindow 的标红并写「悬着 N 章」。
 */
export function ThreadTimeline() {
  const { data: book } = useBook()
  const { data, isLoading } = useThreads()

  const chapters = book?.chapters.map((c) => c.chapterNo) ?? []
  const lastChapter = chapters.length > 0 ? Math.max(...chapters) : 0
  const threads = data?.threads ?? []
  const maxNo = Math.max(
    lastChapter,
    ...threads.flatMap((t) => [
      t.plantedChapter ?? 0,
      t.resolvedChapter ?? 0,
      ...t.advancedChapters,
    ]),
    1,
  )

  if (isLoading) return <p className="p-6 text-sm text-neutral-500">读取线索…</p>

  if (threads.length === 0) {
    return (
      <div className="p-6">
        <p className="text-sm text-neutral-600">这本书还没有登记线索</p>
        <p className="mt-1 text-xs text-neutral-400">
          写 story/threads.json（伏笔 / 埋设 / 回收）后这里会出现生命周期
        </p>
      </div>
    )
  }

  const pct = (n: number): string => `${((n - 1) / Math.max(1, maxNo - 1)) * 100}%`
  const overdueCount = threads.filter((t) => t.overdue).length

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3 text-xs text-neutral-600">
        <span>
          {threads.length} 条线索 · 当前写第 {data?.currentChapter ?? 0} 章
        </span>
        {overdueCount > 0 && (
          <span className="rounded bg-rose-50 px-2 py-0.5 text-rose-700">
            {overdueCount} 条已逾期未回收
          </span>
        )}
        <span className="ml-auto text-neutral-400">线断在右边 = 还没回收</span>
      </div>

      <div className="space-y-2">
        {threads.map((t) => (
          <ThreadRowView key={t.id} thread={t} pct={pct} maxNo={maxNo} />
        ))}
      </div>

      <div className="mt-3 flex justify-between text-[10px] text-neutral-400">
        <span>第 1 章</span>
        <span>第 {maxNo} 章</span>
      </div>
    </div>
  )
}

function ThreadRowView({
  thread,
  pct,
  maxNo,
}: {
  thread: ThreadRow
  pct: (n: number) => string
  maxNo: number
}) {
  const color = KIND_COLOR[thread.kind] ?? '#475569'
  const planted = thread.plantedChapter
  const resolved = thread.resolvedChapter
  const colorClass = thread.overdue
    ? 'text-rose-700'
    : thread.status === 'resolved'
      ? 'text-emerald-700'
      : 'text-neutral-700'

  // ★ 未回收：实线右端留 64px 断口，再用一小段虚线收尾。
  //   线画满会让「没回收」看起来像「已完成」——这个视图唯一要一眼
  //   说清的就是这件事。
  const plantedPct = planted === null ? 0 : ((planted - 1) / Math.max(1, maxNo - 1)) * 100
  const lineLeft = planted === null ? '0%' : pct(planted)
  const lineWidth =
    resolved === null
      ? `calc(${100 - plantedPct}% - 64px)`
      : `calc(${((resolved - (planted ?? 1)) / Math.max(1, maxNo - 1)) * 100}% + 2px)`

  return (
    <div className="rounded border border-neutral-200 bg-white px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-neutral-800">{thread.title}</span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{ backgroundColor: `${color}1a`, color }}
        >
          {KIND_LABEL[thread.kind] ?? thread.kind}
        </span>
        <span className={`text-[10px] ${colorClass}`}>
          {thread.status === 'resolved'
            ? `第 ${resolved ?? '?'} 章回收`
            : thread.overdue
              ? `悬着（期望第 ${thread.payoffWindow} 章前回收）`
              : '进行中'}
        </span>
      </div>

      <div className="relative mt-2 h-3">
        <div className="absolute inset-y-1/2 h-px w-full bg-neutral-100" />
        <div
          className="absolute top-1/2 h-0.5 -translate-y-1/2"
          style={{ left: lineLeft, width: lineWidth, backgroundColor: color }}
        />
        {/* 未回收：断口右侧一小段虚线，表示「还没接上」 */}
        {resolved === null && (
          <div
            className="absolute top-1/2 h-0.5 w-8 -translate-y-1/2"
            style={{
              left: `calc(100% - 44px)`,
              backgroundImage: `repeating-linear-gradient(to right, ${color} 0 3px, transparent 3px 6px)`,
              opacity: 0.5,
            }}
          />
        )}
        {/* 埋设点 */}
        {planted !== null && (
          <span
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
            style={{ left: pct(planted), backgroundColor: color }}
            title={`第 ${planted} 章埋设`}
          />
        )}
        {/* 推进点（小一圈） */}
        {thread.advancedChapters.map((n) => (
          <span
            key={n}
            className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: pct(n), backgroundColor: color, opacity: 0.55 }}
            title={`第 ${n} 章推进`}
          />
        ))}
        {/* 回收点 */}
        {resolved !== null && (
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-emerald-600"
            style={{ left: pct(resolved) }}
            title={`第 ${resolved} 章回收`}
          />
        )}
      </div>

      {thread.payoffHint.length > 0 && thread.status !== 'resolved' && (
        <p className="mt-1 text-[10px] text-neutral-400">回收提示：{thread.payoffHint}</p>
      )}
    </div>
  )
}
