import { describe, expect, it } from 'vitest'
import { countWords } from './words.js'

describe('countWords', () => {
  it('纯汉字按字计', () => {
    expect(countWords('林岚踏上山道')).toBe(6)
  })

  it('忽略段标记与场景头', () => {
    const raw = '<!-- scene:1 v:1 -->\n<!-- seg:a3f7 -->\n林岚踏上山道'
    expect(countWords(raw)).toBe(6)
  })

  it('忽略空白与标点', () => {
    // 林/岚/踏/上/山/道/风/起 = 8 个汉字，逗号句号空格全部不计
    expect(countWords('林岚，踏上山道。\n\n风起！')).toBe(8)
  })

  it('英文按字母计（spec §2.7 六 口径）', () => {
    expect(countWords('abc')).toBe(3)
  })

  it('数字串每个数字计 1', () => {
    expect(countWords('第12章')).toBe(4)
  })

  it('空串为 0', () => {
    expect(countWords('')).toBe(0)
  })

  it('多行软换行不额外计', () => {
    expect(countWords('甲\n乙')).toBe(2)
  })
})
