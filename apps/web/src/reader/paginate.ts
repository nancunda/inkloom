/**
 * 分页算术：把「CSS 多栏排版量出来的宽度」换算成列数、屏数与位移。
 *
 * ★ 断行交给浏览器（column-width / column-fill），这里只做算术——
 *   自己切中文会在标点、引号、拉丁词中间断错，而浏览器已经处理得很好。
 * ★ 全部是纯函数：DOM 只负责量一个 scrollWidth，剩下的都可单测。
 */

/** scrollWidth → 列数（末尾不足一列也算一列） */
export function columnCount(scrollWidth: number, colWidth: number, gap: number): number {
  const step = colWidth + gap
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(step)) return 0
  if (scrollWidth <= 0 || colWidth <= 0 || step <= 0) return 0
  return Math.max(1, Math.ceil(scrollWidth / step))
}

/** 一屏展示两列 → 屏数 */
export function spreadCount(columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 0
  return Math.ceil(columns / 2)
}

/** 第 spread 屏的横向位移（向左为负；归一化 -0） */
export function translationFor(spread: number, colWidth: number, gap: number): number {
  const offset = -2 * spread * (colWidth + gap)
  return offset === 0 ? 0 : offset
}

/** 把屏号卡在合法区间；没有屏时回 0 */
export function clampSpread(spread: number, spreads: number): number {
  if (!Number.isFinite(spread) || !Number.isFinite(spreads) || spreads <= 0) return 0
  return Math.min(Math.max(Math.trunc(spread), 0), spreads - 1)
}

/**
 * 重排（窗口缩放 / 字号变化）后按比例还原：读到 55% 就还在 55%。
 * ★ 用「屏号 / (总屏数 - 1)」而不是「屏号 / 总屏数」，否则最后一屏永远还原不到位。
 */
export function spreadAfterReflow(spread: number, fromSpreads: number, toSpreads: number): number {
  if (fromSpreads <= 1 || toSpreads <= 1) return 0
  const ratio = clampSpread(spread, fromSpreads) / (fromSpreads - 1)
  return clampSpread(Math.round(ratio * (toSpreads - 1)), toSpreads)
}

/** 当前屏左右两页的页码；该页不存在时为 0（不显示） */
export function pageNumbers(spread: number, columns: number): { left: number; right: number } {
  const left = spread * 2 + 1
  const right = left + 1
  return {
    left: left > 0 && left <= columns ? left : 0,
    right: right <= columns ? right : 0,
  }
}
