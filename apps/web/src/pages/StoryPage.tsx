import { useState } from 'react'
import { StoryMap } from '../components/StoryMap'
import { ThreadTimeline } from '../components/ThreadTimeline'
import { useSessionStore } from '../stores/session'

/**
 * 故事（spec §2.1 ④）：叙事地图与剧情线索。
 *
 * ★ 两块都保留「一眼看出结构」的读法：地图看张力起伏，轨迹看哪条线悬着。
 * ★ 点地图节点直接进写作——「看到问题 → 去改」中间不该有第二跳。
 */
export function StoryPage() {
  const [tab, setTab] = useState<'map' | 'threads'>('map')
  const setChapter = useSessionStore((s) => s.setChapter)

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">故事</h1>
        <div className="flex gap-1">
          {(['map', 'threads'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                tab === t ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600'
              }`}
            >
              {t === 'map' ? '叙事地图' : '线索轨迹'}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-neutral-400">
          {tab === 'map' ? '点节点跳到该章写作' : '线断在右边 = 还没回收'}
        </span>
      </header>

      <div className="min-h-0 flex-1">
        {tab === 'map' ? <StoryMap onPick={(n) => setChapter(n)} /> : <ThreadTimeline />}
      </div>
    </div>
  )
}
