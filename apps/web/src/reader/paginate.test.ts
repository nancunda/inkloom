import { describe, expect, it } from 'vitest'
import {
  clampSpread,
  columnCount,
  pageNumbers,
  spreadAfterReflow,
  spreadCount,
  translationFor,
} from './paginate'

describe('columnCount', () => {
  it('没有内容时返回 0', () => {
    expect(columnCount(0, 300, 60)).toBe(0)
    expect(columnCount(-10, 300, 60)).toBe(0)
  })

  it('刚好一列 / 一列多一点 / 刚好两列', () => {
    expect(columnCount(300, 300, 60)).toBe(1)
    expect(columnCount(361, 300, 60)).toBe(2)
    expect(columnCount(660, 300, 60)).toBe(2)
    expect(columnCount(721, 300, 60)).toBe(3)
  })

  it('列宽非法时返回 0（不拿 0 去除）', () => {
    expect(columnCount(500, 0, 60)).toBe(0)
    expect(columnCount(500, 300, -360)).toBe(0)
  })
})

describe('spreadCount', () => {
  it('两列一屏，列数为奇数时多一屏', () => {
    expect(spreadCount(0)).toBe(0)
    expect(spreadCount(1)).toBe(1)
    expect(spreadCount(2)).toBe(1)
    expect(spreadCount(3)).toBe(2)
    expect(spreadCount(11)).toBe(6)
  })
})

describe('translationFor', () => {
  it('每次翻屏移动两列', () => {
    expect(translationFor(0, 300, 60)).toBe(0)
    expect(translationFor(1, 300, 60)).toBe(-720)
    expect(translationFor(2, 300, 60)).toBe(-1440)
  })
})

describe('clampSpread', () => {
  it('卡在 [0, spreads-1]', () => {
    expect(clampSpread(-2, 5)).toBe(0)
    expect(clampSpread(0, 5)).toBe(0)
    expect(clampSpread(4, 5)).toBe(4)
    expect(clampSpread(9, 5)).toBe(4)
  })

  it('没有屏时回 0，NaN 也回 0', () => {
    expect(clampSpread(3, 0)).toBe(0)
    expect(clampSpread(Number.NaN, 5)).toBe(0)
  })
})

describe('spreadAfterReflow', () => {
  it('按比例还原：重排后仍停在相近的进度上', () => {
    // 10 屏里的第 5 屏（约 55%）→ 20 屏 → 11
    expect(spreadAfterReflow(5, 10, 20)).toBe(11)
    // 20 屏里的第 11 屏 → 10 屏 → 5
    expect(spreadAfterReflow(11, 20, 10)).toBe(5)
  })

  it('原来只有一屏或重排后只有一屏 → 回第一屏', () => {
    expect(spreadAfterReflow(0, 1, 8)).toBe(0)
    expect(spreadAfterReflow(3, 8, 1)).toBe(0)
  })

  it('结果仍被卡在合法区间', () => {
    expect(spreadAfterReflow(99, 10, 3)).toBe(2)
  })
})

describe('pageNumbers', () => {
  it('每屏两页，从 1 开始', () => {
    expect(pageNumbers(0, 10)).toEqual({ left: 1, right: 2 })
    expect(pageNumbers(3, 20)).toEqual({ left: 7, right: 8 })
  })

  it('最后一屏只有一页时右边不显示页码', () => {
    expect(pageNumbers(1, 3)).toEqual({ left: 3, right: 0 })
    expect(pageNumbers(1, 4)).toEqual({ left: 3, right: 4 })
  })
})
