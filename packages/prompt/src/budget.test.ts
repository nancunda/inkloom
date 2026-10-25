import { describe, expect, it } from 'vitest'
import { applyBudget, estimateTokens } from './budget.js'
import type { PromptBlock } from './types.js'

const block = (
  id: string,
  priority: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
  chars: number,
): PromptBlock => ({
  id: id as PromptBlock['id'],
  role: id.startsWith('S') ? 'system' : 'user',
  priority,
  content: '䕀'.repeat(chars),
})

const cfg = { denominator: 1000, warnRatio: 0.7, promptRatio: 0.85, forceRatio: 0.95 }

describe('estimateTokens', () => {
  it('中文按约 1.5 字/token', () => {
    expect(estimateTokens('䕀'.repeat(150))).toBe(100)
  })

  it('英文按约 4 字符/token', () => {
    expect(estimateTokens('abcd'.repeat(25))).toBe(25)
  })

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('applyBudget', () => {
  it('预算充足时不裁剪，tier=normal', () => {
    const blocks = [block('U6', 0, 100), block('U4', 2, 100)]
    const r = applyBudget(blocks, cfg)
    expect(r.tier).toBe('normal')
    expect(r.degradation).toHaveLength(0)
    expect(r.blocks).toHaveLength(2)
  })

  it('★ P2–P7 按优先级从低到高被 drop', () => {
    // 每块 500 字 ≈ 334 token，三块 ≈ 1002 token → 超过 0.85
    const blocks = [block('U6', 0, 500), block('U2', 7, 500), block('U7', 6, 500)]
    const r = applyBudget(blocks, cfg)
    const kept = r.blocks.map((b) => b.id)
    expect(kept).toContain('U6') // P0 不裁
    expect(kept).not.toContain('U2') // P7 先被裁
  })

  it('★ P0/P1 永不裁剪（宁可超预算）', () => {
    const blocks = [block('U6', 0, 2000), block('U1', 1, 2000)]
    const r = applyBudget(blocks, cfg)
    expect(r.blocks.map((b) => b.id)).toEqual(['U6', 'U1'])
  })

  it('★ 每次裁剪都写进 degradation', () => {
    const blocks = [block('U6', 0, 500), block('U2', 7, 500), block('U7', 6, 500)]
    const r = applyBudget(blocks, cfg)
    expect(r.degradation.length).toBeGreaterThan(0)
    expect(r.degradation[0]?.action).toBe('drop')
    expect(r.degradation[0]?.blockId).toBe('U2')
  })

  it('按使用率返回 tier', () => {
    expect(applyBudget([block('U6', 0, 100)], cfg).tier).toBe('normal')
    expect(applyBudget([block('U6', 0, 1100)], cfg).tier).toBe('warn')
    expect(applyBudget([block('U6', 0, 1400)], cfg).tier).toBe('prompt')
    expect(applyBudget([block('U6', 0, 2000)], cfg).tier).toBe('force')
  })

  it('null 内容的块不参与 token 计算', () => {
    const withNull: PromptBlock = { id: 'U8', role: 'user', priority: 4, content: null }
    const r = applyBudget([block('U6', 0, 100), withNull], cfg)
    expect(r.blocks).toHaveLength(2)
    expect(r.usedRatio).toBeLessThan(0.2)
  })

  it('priority ≥2 全被裁完才停手（不会裁到 P0/P1）', () => {
    // U6 1200 字 ≈ 800 token；三个 P≥2 块各 200 字 ≈ 134 token
    // 初始 1202 → 裁 U2 → 1068 → 裁 U7 → 934 → 裁 U4 → 800（0.80 < 0.85 停）
    const blocks = [
      block('U6', 0, 1200),
      block('U2', 7, 200),
      block('U7', 6, 200),
      block('U4', 2, 200),
    ]
    const r = applyBudget(blocks, cfg)
    expect(r.blocks.map((b) => b.id)).toEqual(['U6'])
    expect(r.degradation).toHaveLength(3)
    // 裁剪顺序：P7 → P6 → P2
    expect(r.degradation.map((d) => d.blockId)).toEqual(['U2', 'U7', 'U4'])
  })
})
