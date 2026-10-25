import { describe, expect, it } from 'vitest'
import { diffText, renderDiffHints, summarizeDiff } from './chars.js'

describe('diffText — 中文', () => {
  it('★ 字符级：remove 去除 + add 插入能精确还原新文本', () => {
    const spans = diffText('林岚踏上山道', '林岚走下山道')
    const join = (op: 'same' | 'add' | 'remove'): string =>
      spans
        .filter((s) => s.op === op)
        .map((s) => s.text)
        .join('')
    // ★ span 是有序的：还原旧文 = 按原序保留 same+remove（过滤 add）
    //   不能写成 join('same') + join('remove')，那会把 remove 全挪到末尾。
    const oldRebuilt = spans
      .filter((s) => s.op !== 'add')
      .map((s) => s.text)
      .join('')
    const newRebuilt = spans
      .filter((s) => s.op !== 'remove')
      .map((s) => s.text)
      .join('')
    expect(oldRebuilt).toBe('林岚踏上山道')
    expect(newRebuilt).toBe('林岚走下山道')
    expect(join('same')).toBe('林岚山道')
  })

  it('★ 纯标点变化也能识别', () => {
    const spans = diffText('她没停。', '她没停，')
    expect(summarizeDiff(spans).removedChars).toBe(1)
    expect(summarizeDiff(spans).addedChars).toBe(1)
  })

  it('内容相同 → 只有 same', () => {
    const spans = diffText('剑气贴着面颊削过去。', '剑气贴着面颊削过去。')
    expect(spans.every((s) => s.op === 'same')).toBe(true)
    expect(summarizeDiff(spans).similarity).toBe(1)
  })

  it('★ 全新内容 → similarity 为 0', () => {
    const spans = diffText('甲甲甲', '乙乙乙')
    expect(summarizeDiff(spans).similarity).toBe(0)
  })

  it('旧文为空 → 全部 add', () => {
    const spans = diffText('', '甲乙丙')
    expect(
      spans
        .filter((s) => s.op === 'add')
        .map((s) => s.text)
        .join(''),
    ).toBe('甲乙丙')
    expect(summarizeDiff(spans).removedChars).toBe(0)
  })

  it('新文为空 → 全部 remove', () => {
    const spans = diffText('甲乙丙', '')
    expect(summarizeDiff(spans).addedChars).toBe(0)
    expect(summarizeDiff(spans).removedChars).toBe(3)
  })

  it('两边都空 → similarity 为 1（不是 NaN）', () => {
    expect(summarizeDiff(diffText('', '')).similarity).toBe(1)
  })
})

describe('diffText — 换行', () => {
  it('★ 段落增删保留换行符（否则终端视图会粘连）', () => {
    const spans = diffText('甲\n\n乙', '甲\n\n乙\n\n丙')
    const joined = spans.map((s) => s.text).join('')
    expect(joined).toBe('甲\n\n乙\n\n丙')
  })
})

describe('summarizeDiff', () => {
  it('统计三类字符数', () => {
    const s = summarizeDiff(diffText('甲乙丙丁', '甲乙戊丁'))
    expect(s.unchangedChars).toBe(3)
    expect(s.addedChars).toBe(1)
    expect(s.removedChars).toBe(1)
  })

  it('★ similarity 用 max(lenA,lenB) 作分母（不是 lenA+lenB）', () => {
    // 旧 4 字，新 6 字，相同 4 字 → 4/6
    const s = summarizeDiff(diffText('甲乙丙丁', '甲乙丙丁戊己'))
    expect(s.similarity).toBeCloseTo(4 / 6, 5)
  })
})

describe('renderDiffHints', () => {
  it('★ 只列 add / remove，不列 same', () => {
    const hints = renderDiffHints(diffText('甲乙丙', '甲丁丙'))
    expect(hints.some((h) => h.startsWith('+'))).toBe(true)
    expect(hints.some((h) => h.startsWith('-'))).toBe(true)
    expect(hints.every((h) => h.startsWith('+') || h.startsWith('-'))).toBe(true)
  })

  it('超过 maxHints 时截断并提示还剩多少处', () => {
    // 交替字符 → 公共子序列是 abcde，产生 5 处 remove + 5 处 add
    const hints = renderDiffHints(diffText('a1b2c3d4e5', 'aXbYcZdWeV'), 3)
    expect(hints).toHaveLength(4) // 3 条 + 1 条「还有 N 处」
    expect(hints[3]).toContain('还有')
  })

  it('无差异时返回空数组', () => {
    expect(renderDiffHints(diffText('同一段', '同一段'))).toEqual([])
  })

  it('★ 空白变更可视化（空格显示成 ·，否则看不出改了什么）', () => {
    const hints = renderDiffHints(diffText('甲', '甲 '))
    expect(hints).toEqual(['+ ·'])
  })
})
