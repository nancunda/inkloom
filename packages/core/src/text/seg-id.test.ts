import { InkloomError } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { collectSegIds, newSegId } from './seg-id.js'

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 确定性随机源：按队列依次返回，用完后循环 */
function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length] as number
}

describe('newSegId', () => {
  it('生成 4 位 base36', () => {
    const id = newSegId(seq([0]), new Set())
    expect(id).toBe('0000')
    expect(id).toHaveLength(4)
  })

  it('全部字符都在 base36 字符集内', () => {
    const id = newSegId(Math.random, new Set())
    expect(id).toHaveLength(4)
    for (const ch of id) expect(BASE36).toContain(ch)
  })

  it('★ 坏随机源不产出非法 ID（NaN 会拼出 undefined… 串）', () => {
    expect(() => newSegId(() => Number.NaN, new Set())).toThrowError(InkloomError)
  })

  it('随机源返回 1（越界）时不会产出空字符', () => {
    const id = newSegId(() => 1, new Set())
    expect(id).toBe('zzzz')
  })

  it('碰撞时重新生成', () => {
    // 第一轮全 0 → "0000"（已占用），第二轮全 1/36 → "1111"
    const rand = seq([0, 0, 0, 0, 1 / 36, 1 / 36, 1 / 36, 1 / 36])
    const id = newSegId(rand, new Set(['0000']))
    expect(id).toBe('1111')
  })

  it('连续生成 1000 个不重复', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = newSegId(Math.random, taken)
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
    expect(taken.size).toBe(1000)
  })
})

describe('collectSegIds', () => {
  it('汇总多个场景文件的段 ID', () => {
    const s = collectSegIds([
      { segments: [{ segId: 'aaaa' }, { segId: 'bbbb' }] },
      { segments: [{ segId: 'cccc' }] },
    ])
    expect(s).toEqual(new Set(['aaaa', 'bbbb', 'cccc']))
  })

  it('空输入返回空集合', () => {
    expect(collectSegIds([]).size).toBe(0)
  })
})
