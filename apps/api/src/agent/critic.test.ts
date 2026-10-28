import { describe, expect, it } from 'vitest'
import { decideCritic, parseCriticReport } from './critic.js'

describe('parseCriticReport', () => {
  it('★ 纯 JSON 与 ```json 围栏都能解析', () => {
    const body = JSON.stringify({
      conflicts: [
        {
          severity: 'error',
          message: '第 3 章已筑基，角色卡仍是炼气',
          evidence: ['characters/index.json#c1'],
        },
      ],
      suggestions: ['补一条 events 记录'],
    })
    for (const text of [body, `\`\`\`json\n${body}\n\`\`\``]) {
      const r = parseCriticReport(text)
      expect(r?.conflicts).toHaveLength(1)
      expect(r?.suggestions).toEqual(['补一条 events 记录'])
    }
  })

  it('★ 坏 JSON / 结构不对 → null', () => {
    expect(parseCriticReport('不是 JSON')).toBeNull()
    expect(parseCriticReport('{"conflicts":"nope"}')).toBeNull()
    expect(parseCriticReport('[]')).toBeNull()
  })

  it('★ 没有 evidence 的矛盾被丢弃（没证据不采信）', () => {
    const r = parseCriticReport(
      JSON.stringify({
        conflicts: [
          { severity: 'error', message: '没有证据', evidence: [] },
          { severity: 'warning', message: '有证据', evidence: ['world/rules.json'] },
        ],
      }),
    )
    expect(r?.conflicts.map((c) => c.message)).toEqual(['有证据'])
    expect(r?.suggestions).toEqual([])
  })

  it.each([
    ['severity 大写', { conflicts: [{ severity: 'Error', message: 'x', evidence: ['a.json'] }] }],
    ['字段名错', { conflicts: [{ level: 'error', message: 'x', evidence: ['a.json'] }] }],
    ['evidence 是字符串', { conflicts: [{ severity: 'error', message: 'x', evidence: 'a.json' }] }],
    ['message 为空', { conflicts: [{ severity: 'error', message: '', evidence: ['a.json'] }] }],
    ['元素是字符串', { conflicts: ['error: x (a.json)'] }],
  ])('★ 形状非法 → null（不能静默变成空 conflicts）：%s', (_name, body) => {
    expect(parseCriticReport(JSON.stringify(body))).toBeNull()
  })

  it('★ 围栏前后带解释文字也能解析（模型常态输出）', () => {
    const body = JSON.stringify({
      conflicts: [{ severity: 'error', message: 'x', evidence: ['a.json'] }],
    })
    const text = `检查结果如下：\n\`\`\`json\n${body}\n\`\`\`\n以上。`
    expect(parseCriticReport(text)?.conflicts).toHaveLength(1)
  })

  it('★ suggestions 为 null 不算失败', () => {
    expect(parseCriticReport('{"conflicts":[],"suggestions":null}')).toEqual({
      conflicts: [],
      suggestions: [],
    })
  })
})

describe('decideCritic', () => {
  it('★ 只有 error 阻断；warning 放行', () => {
    const warning = {
      conflicts: [{ severity: 'warning' as const, message: '称谓不统一', evidence: ['a.json'] }],
      suggestions: [],
    }
    expect(decideCritic(warning).kind).toBe('passed')

    const error = {
      conflicts: [
        { severity: 'error' as const, message: '境界矛盾', evidence: ['b.json'] },
        ...warning.conflicts,
      ],
      suggestions: ['改角色卡'],
    }
    const v = decideCritic(error)
    expect(v.kind).toBe('blocked')
    if (v.kind !== 'blocked') return
    expect(v.errors).toHaveLength(1)
    expect(v.warnings).toHaveLength(1)
  })

  it('★ null → skipped（故障按未完成处理）', () => {
    expect(decideCritic(null)).toEqual({ kind: 'skipped', reason: '返回内容不是合法 JSON' })
  })

  it('★ 端到端：出现 error 时绝不会被判成 passed', () => {
    const text = JSON.stringify({
      conflicts: [{ severity: 'error', message: '境界矛盾', evidence: ['characters/index.json'] }],
    })
    expect(decideCritic(parseCriticReport(text)).kind).toBe('blocked')
  })
})
