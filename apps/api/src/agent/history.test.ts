import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compactMessages,
  loadMessageSnapshot,
  saveMessageSnapshot,
  stripSystemMessages,
} from './history.js'

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as unknown as AgentMessage
}
function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 2,
  } as unknown as AgentMessage
}
function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'web_search',
    content: [{ type: 'text', text }],
    timestamp: 3,
  } as unknown as AgentMessage
}

describe('stripSystemMessages', () => {
  it('★ 丢掉所有 system：工具声明会随代码变化，不能复用旧 system', () => {
    const out = stripSystemMessages([
      { role: 'system', content: '旧提示词', timestamp: 0 } as unknown as AgentMessage,
      user('你好'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
  })
})

describe('compactMessages', () => {
  it('★ 最近 keepRecent 条原样保留', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => user(`第 ${i} 条`))
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 100_000 })
    expect(out).toHaveLength(12)
    expect(out.at(-1)).toEqual(msgs.at(-1))
  })

  it('★ 早期的 toolResult 被截断并加标注', () => {
    const long = 'x'.repeat(5000)
    const msgs = [
      user('目标'),
      toolResult(long),
      ...Array.from({ length: 8 }, (_, i) => user(`近 ${i}`)),
    ]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 1000 })
    const early = out[1] as { content: { text: string }[] }
    expect(early.content[0]?.text.length).toBeLessThan(600)
    expect(early.content[0]?.text).toContain('早期工具输出已压缩')
  })

  it('★ 超出字符预算时从最旧开始丢，但保留首条 user 与最近 2 条', () => {
    const msgs = [
      user('原始目标'),
      ...Array.from({ length: 40 }, () => assistant('y'.repeat(5000))),
    ]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 20_000 })
    expect((out[0] as { content: string }).content).toBe('原始目标')
    expect(out.at(-1)).toEqual(msgs.at(-1))
    expect(out.length).toBeLessThan(msgs.length)
  })
})

describe('message snapshot', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inkloom-hist-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('★ 写入后可读回，且目录自动创建', async () => {
    await saveMessageSnapshot(root, 'cs_abc', {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionId: 'cs_abc',
      runId: 'ar_1',
      messages: [user('你好')],
    })
    const back = await loadMessageSnapshot(root, 'cs_abc')
    expect(back?.messages).toHaveLength(1)
  })

  it('没有快照时返回 null', async () => {
    expect(await loadMessageSnapshot(root, 'cs_none')).toBeNull()
  })

  it('★ 存盘前就剥掉 system 并裁剪：续接时只读用户与模型的消息', async () => {
    await saveMessageSnapshot(root, 'cs_strip', {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionId: 'cs_strip',
      runId: 'ar_1',
      messages: [
        { role: 'system', content: '旧工具声明', timestamp: 0 } as unknown as AgentMessage,
        user('目标'),
      ],
    })
    const back = await loadMessageSnapshot(root, 'cs_strip')
    expect(back?.messages.map((m) => m.role)).toEqual(['user'])
  })
})
