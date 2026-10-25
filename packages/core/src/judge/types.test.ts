import { describe, expect, it } from 'vitest'
import { createMockJudge } from './mock.js'
import { JUDGE_INJECT_THRESHOLD, shouldInject } from './types.js'

describe('judge 接口', () => {
  it('★ 批量：N 个问题一次发出去，按序返回 N 个结果', async () => {
    const { provider, calls } = createMockJudge((_req, i) => ({
      value: i === 0 ? '退让' : 4,
      confidence: 0.9,
    }))
    const results = await provider.judge([
      { primitive: 'choice', question: '他会怎么做', options: ['强攻', '退让'], context: '…' },
      { primitive: 'score', question: '这段是否拖沓', scale: [1, 5], context: '…' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(2)
    expect(results.map((r) => r.value)).toEqual(['退让', 4])
  })

  it('★ 置信度 ≥ 0.75 才允许注入 prompt', () => {
    expect(shouldInject({ value: 'x', confidence: 0.75 })).toBe(true)
    expect(shouldInject({ value: 'x', confidence: 0.74 })).toBe(false)
    expect(JUDGE_INJECT_THRESHOLD).toBe(0.75)
  })

  it('非法置信度（NaN）不注入', () => {
    expect(shouldInject({ value: 'x', confidence: Number.NaN })).toBe(false)
  })

  it('空请求返回空数组（不抛错）', async () => {
    const { provider } = createMockJudge(() => ({ value: true, confidence: 1 }))
    await expect(provider.judge([])).resolves.toEqual([])
  })
})
