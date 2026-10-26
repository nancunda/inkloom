import { WorldMap } from '../components/WorldMap'

/** 世界（spec §2.1 ②）：规则、地点、路线。本轮先接地点/路线图，规则表下一轮。 */
export function WorldPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-6 py-3">
        <h1 className="text-sm font-semibold text-neutral-900">世界</h1>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          地点与路线。路线上的天数由系统计算，写作时直接引用（「走了三天」）。
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <WorldMap />
      </div>
    </div>
  )
}
