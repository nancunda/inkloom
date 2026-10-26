import { describe, expect, it } from 'vitest'
import { powerSystemFileSchema } from './tools.js'

describe('powerSystemFileSchema', () => {
  // 回归：2026-10 实测 agent 写出 world/power-system.json 后只剩 id/name，
  // 因为 powerSystemSchema 不含 tiers，Zod 解析成功但静默丢弃。E2E 全书设定因此丢了一半。
  it('保留 tiers 数组', () => {
    const parsed = powerSystemFileSchema.safeParse({
      id: 'ps_tide',
      projectId: 'p1',
      name: '潮汐阶序',
      description: '以潮汐刻度衡量修为',
      tiers: [
        { id: 't1', systemId: 'ps_tide', name: '观潮', level: 1, description: '初窥潮声' },
        { id: 't2', systemId: 'ps_tide', name: '听涛', level: 2 },
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.tiers).toHaveLength(2)
    expect(parsed.data.tiers[1]?.name).toBe('听涛')
  })

  it('tiers 缺省时给空数组，不让解析失败', () => {
    const parsed = powerSystemFileSchema.safeParse({ id: 'ps1', projectId: 'p1', name: '阶序' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.tiers).toEqual([])
  })

  it('passthrough 保留 agent 多写的字段', () => {
    const parsed = powerSystemFileSchema.safeParse({
      id: 'ps1',
      projectId: 'p1',
      name: '阶序',
      summary: '一句话概括',
      constraints: ['越级必伤'],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const raw = parsed.data as Record<string, unknown>
    expect(raw['summary']).toBe('一句话概括')
    expect(raw['constraints']).toEqual(['越级必伤'])
  })
})
