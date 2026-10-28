import { NODE_TYPES, TYPE_COLOR, TYPE_LABEL } from './graph-theme'

/** 画布左下角的图例：颜色表达类型，线型表达数据来源 */
export function GraphLegend() {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-neutral-200 bg-white/95 px-3 py-2 text-[10px] leading-4 text-neutral-500">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {NODE_TYPES.map((t) => (
          <span key={t} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm border-2"
              style={{ borderColor: TYPE_COLOR[t] }}
            />
            {TYPE_LABEL[t] ?? t}
          </span>
        ))}
      </div>
      <p className="mt-1 border-t border-neutral-100 pt-1">
        虚线框 / 虚线边 = 既有数据的只读投影 · 淡出边 = 已废止 · 浅灰框 = 类分组
      </p>
    </div>
  )
}
