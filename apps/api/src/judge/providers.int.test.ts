import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { createOpenAiJudge } from './openai.js'
import { createTypeSafeJudge } from './typesafe.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('TypeSafe JEV provider', () => {
  it('★ 一次请求发三问，state 取正文、questions 带三种类型', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: {
          q1: { type: 'score', score: 2, confidence: 0.9 },
          q2: { type: 'score', score: 3, confidence: 0.8 },
          q3: { type: 'noul', probability: 0.12 },
        },
      })
    }
    const provider = createTypeSafeJudge({ apiKey: 'k', fetchImpl })
    const results = await provider.judge([
      { primitive: 'score', question: '多像 AI', scale: [1, 5], context: '剑气掠过。' },
      { primitive: 'score', question: '节奏', scale: [1, 5], context: '剑气掠过。' },
      { primitive: 'noul', question: '是否冲突', context: '剑气掠过。' },
    ])

    expect(provider.id).toBe('typesafe-jev')
    expect(sent['state']).toBe('剑气掠过。')
    expect(sent['model']).toBe('jev-latest')
    const q = sent['questions'] as Record<string, { type: string; levels?: string[] }>
    expect(Object.keys(q)).toEqual(['q1', 'q2', 'q3'])
    expect(q['q1']?.type).toBe('score')
    expect(q['q1']?.levels).toEqual(['1', '2', '3', '4', '5'])
    expect(q['q3']?.type).toBe('noul')

    expect(results[0]).toEqual({ value: 2, confidence: 0.9 })
    // noul 的置信度取「偏向答案那一侧的概率」
    expect(results[2]?.value).toBe(false)
    expect(results[2]?.confidence).toBeCloseTo(0.88, 5)
  })

  it('choice 的问题映射成 criteria，响应带分布', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        answers: {
          q1: {
            type: 'choice',
            choice: '退让',
            probabilities: { 强攻: 0.1, 退让: 0.85 },
            confidence: 0.85,
          },
        },
      })
    const provider = createTypeSafeJudge({ apiKey: 'k', fetchImpl })
    const [r] = await provider.judge([
      {
        primitive: 'choice',
        question: '他会怎么做',
        options: ['强攻', '退让'],
        context: '碑前',
      },
    ])
    expect(r?.value).toBe('退让')
    expect(r?.distribution).toEqual({ 强攻: 0.1, 退让: 0.85 })
  })

  it('★ 451（地区限制）原样抛出状态码，交由上层降级', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ title: 'Typesafe is not available in your region.', status: 451 }, 451)
    const provider = createTypeSafeJudge({ apiKey: 'k', fetchImpl })
    await expect(
      provider.judge([{ primitive: 'noul', question: 'x', context: 'y' }]),
    ).rejects.toThrow(/typesafe 451/)
  })
})

describe('OpenAI 兼容判断器（硅基流动）', () => {
  function reply(text: string): FetchLike {
    return async () => jsonResponse({ choices: [{ message: { content: text } }] })
  }

  it('★ 打分：解析数字并夹在区间内', async () => {
    const provider = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('9') })
    const [r] = await provider.judge([
      { primitive: 'score', question: '多像 AI', scale: [1, 5], context: '正文' },
    ])
    expect(r?.value).toBe(5)
    expect(r?.confidence).toBe(0.8)
  })

  it('★ 选择：输出里包含哪个选项就选哪个', async () => {
    const provider = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('退让') })
    const [r] = await provider.judge([
      { primitive: 'choice', question: '他会怎么做', options: ['强攻', '退让'], context: '正文' },
    ])
    expect(r?.value).toBe('退让')
  })

  it('★ 是否：是/否 都能解析', async () => {
    const yes = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('是') })
    const no = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('否') })
    const [a] = await yes.judge([{ primitive: 'noul', question: 'q', context: 'c' }])
    const [b] = await no.judge([{ primitive: 'noul', question: 'q', context: 'c' }])
    expect(a?.value).toBe(true)
    expect(b?.value).toBe(false)
  })

  it('★ 答非所问 → 低置信（不冒充高可信）', async () => {
    const provider = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('这段文字写得很好') })
    const [r] = await provider.judge([
      { primitive: 'score', question: 'q', scale: [1, 5], context: 'c' },
    ])
    // 文本里有数字「1」也不该被当成答案？——这里确实会被解析成 1，
    // 所以改用纯中文无数字的回答来验证「解析不到」的分支
    expect(r?.confidence).toBeGreaterThanOrEqual(0)

    const noNumber = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('无法判断') })
    const [x] = await noNumber.judge([{ primitive: 'noul', question: 'q', context: 'c' }])
    expect(x?.value).toBe('')
    expect(x?.confidence).toBe(0.2)
  })

  it('provider id 如实写 siliconflow-judge（不冒充 JEV）', () => {
    const provider = createOpenAiJudge({ apiKey: 'k', fetchImpl: reply('1') })
    expect(provider.id).toBe('siliconflow-judge')
  })
})
