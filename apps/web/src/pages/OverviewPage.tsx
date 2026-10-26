import { useOverview } from '../api/hooks'
import { STATUS_LABEL, STATUS_MARK } from '../lib/status'
import { useSessionStore } from '../stores/session'

const BEAT_LABEL: Record<string, string> = {
  setup: '铺垫',
  rising: '上升',
  climax: '高潮',
  twist: '转折',
  falling: '回落',
  resolution: '收束',
}

/**
 * 概览（spec §2.1 ①）：这本书现在怎么样。
 *
 * ★ 张力曲线用 SVG 手画：只是 40×8 的折线，引一个图表库不值当。
 * ★ 数据点可点，跳到对应章——曲线不是为了好看，是为了发现「哪几章塌了」。
 */
export function OverviewPage() {
  const { data, isLoading } = useOverview()
  const setChapter = useSessionStore((s) => s.setChapter)

  if (isLoading) return <p className="p-8 text-sm text-neutral-500">读取概览…</p>
  if (data === undefined) return null

  const { chapters, stats, threads, runs } = data
  const w = 720
  const h = 140
  const pad = 24
  const stepX = chapters.length > 1 ? (w - pad * 2) / (chapters.length - 1) : 0
  const y = (t: number): number => h - pad - ((t - 1) / 4) * (h - pad * 2)

  // 连续 3 章张力相同 = 曲线塌了，标出来
  const flat: string[] = []
  for (let i = 0; i + 2 < chapters.length; i += 1) {
    const a = chapters[i]
    const b = chapters[i + 1]
    const c = chapters[i + 2]
    if (
      a !== undefined &&
      b !== undefined &&
      c !== undefined &&
      a.tensionLevel === b.tensionLevel &&
      b.tensionLevel === c.tensionLevel
    ) {
      flat.push(`第 ${a.chapterNo}–${c.chapterNo} 章连续同张力 ${a.tensionLevel}`)
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-8">
        <header>
          <h1 className="text-lg font-semibold text-neutral-900">概览</h1>
          <p className="mt-1 text-xs text-neutral-500">这本书现在怎么样：进度、节奏、悬着的线。</p>
        </header>

        <div className="grid grid-cols-4 gap-3">
          <Stat
            label="定稿进度"
            value={`${stats.finalized}/${stats.total}`}
            sub={`${Math.round(stats.progress * 100)}%`}
          />
          <Stat
            label="全书字数"
            value={stats.words.toLocaleString()}
            sub={`目标 ${(stats.wordsPerChapter / 1000).toFixed(1)}k/章`}
          />
          <Stat
            label="未兑现线索"
            value={String(threads.active)}
            sub={threads.overdue > 0 ? `${threads.overdue} 条逾期` : '无逾期'}
            tone={threads.overdue > 0 ? 'danger' : 'default'}
          />
          <Stat
            label="生成记录"
            value={String(runs.total)}
            sub={runs.failed > 0 ? `${runs.failed} 次失败` : '全部成功'}
          />
        </div>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-neutral-800">张力曲线</h2>
            <span className="text-[11px] text-neutral-400">点数据点跳到该章</span>
          </div>
          {chapters.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-400">还没有章节蓝图</p>
          ) : (
            <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img">
              <title>全书张力曲线：点数据点可跳到该章</title>
              {[1, 2, 3, 4, 5].map((t) => (
                <g key={t}>
                  <line x1={pad} x2={w - pad} y1={y(t)} y2={y(t)} stroke="#f1f5f9" />
                  <text x={4} y={y(t) + 3} fontSize="9" fill="#cbd5e1">
                    {t}
                  </text>
                </g>
              ))}
              <polyline
                fill="none"
                stroke="#334155"
                strokeWidth="1.5"
                points={chapters.map((c, i) => `${pad + i * stepX},${y(c.tensionLevel)}`).join(' ')}
              />
              {chapters.map((c, i) => (
                // biome-ignore lint/a11y/useSemanticElements: SVG 里没有 <button>，数据点用 role=button + 键盘事件
                <circle
                  key={c.chapterNo}
                  cx={pad + i * stepX}
                  cy={y(c.tensionLevel)}
                  r={c.status === 'finalized' ? 3.5 : 2.5}
                  fill={c.status === 'finalized' ? '#0f172a' : '#94a3b8'}
                  className="cursor-pointer"
                  role="button"
                  tabIndex={0}
                  aria-label={`第 ${c.chapterNo} 章 张力 ${c.tensionLevel}`}
                  onClick={() => setChapter(c.chapterNo)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setChapter(c.chapterNo)
                    }
                  }}
                >
                  <title>
                    第 {c.chapterNo} 章 {c.title ?? ''} · 张力 {c.tensionLevel} ·{' '}
                    {BEAT_LABEL[c.beatType] ?? c.beatType} · {STATUS_LABEL[c.status] ?? c.status}
                  </title>
                </circle>
              ))}
            </svg>
          )}
          {flat.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-amber-700">
              {flat.slice(0, 3).map((f) => (
                <li key={f}>⚠ {f}（节奏平了）</li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white">
          <h2 className="border-b border-neutral-100 px-4 py-2 text-sm font-medium text-neutral-800">
            章节
          </h2>
          <ul className="divide-y divide-neutral-50">
            {chapters.map((c) => (
              <li key={c.chapterNo}>
                <button
                  type="button"
                  onClick={() => setChapter(c.chapterNo)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-neutral-50"
                >
                  <span className="w-6 text-neutral-300">{STATUS_MARK[c.status] ?? '○'}</span>
                  <span className="w-10 text-neutral-400">第 {c.chapterNo} 章</span>
                  <span className="flex-1 text-neutral-800">{c.title ?? '—'}</span>
                  <span className="text-[11px] text-neutral-400">
                    {STATUS_LABEL[c.status] ?? c.status}
                  </span>
                  <span className="w-16 text-right text-[11px] text-neutral-400">
                    {c.wordCount} 字
                  </span>
                  <span className="w-24 text-right text-[11px] text-neutral-300">
                    {BEAT_LABEL[c.beatType] ?? c.beatType} · 张力 {c.tensionLevel}
                  </span>
                </button>
              </li>
            ))}
            {chapters.length === 0 && (
              <li className="px-4 py-6 text-center text-xs text-neutral-400">
                还没有章节。去「故事」建蓝图，或直接到「写作」生成第一章。
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: string
  sub: string
  tone?: 'default' | 'danger'
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3">
      <p className="text-[11px] text-neutral-400">{label}</p>
      <p
        className={`mt-1 text-xl font-semibold ${tone === 'danger' ? 'text-rose-700' : 'text-neutral-900'}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-neutral-400">{sub}</p>
    </div>
  )
}
