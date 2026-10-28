import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compactMessages,
  loadMessageSnapshot,
  messageSnapshotPath,
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
function assistantCall(text: string, callId: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'toolCall', id: callId, name: 'web_search', arguments: {} },
    ],
    timestamp: 2,
  } as unknown as AgentMessage
}
function toolResult(text: string, callId = 't1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
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
  it('预算内原样返回（内容不变）', () => {
    const msgs = [user('目标'), assistant('短回复')]
    expect(compactMessages(msgs, { budgetChars: 100_000 })).toEqual(msgs)
  })

  it('★ 最近 keepRecent 条原样保留（真触发裁剪时）', () => {
    const recent = Array.from({ length: 8 }, (_, i) => assistant(`近 ${i} ${'y'.repeat(500)}`))
    const msgs = [
      user('目标'),
      ...Array.from({ length: 10 }, () => user('f'.repeat(100))),
      ...recent,
    ]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 4000 })
    expect(out.slice(-8)).toEqual(recent)
  })

  it('★ 早期的 toolResult 被截断并加标注', () => {
    const long = 'x'.repeat(5000)
    const msgs = [
      user('目标'),
      toolResult(long),
      ...Array.from({ length: 8 }, (_, i) => user(`近 ${i}`)),
    ]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 2000 })
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

  it('★ 落在最近窗口里的 toolCall 与 toolResult 必须同存（拆散会让续接 400）', () => {
    const msgs = [
      user('目标'),
      ...Array.from({ length: 20 }, () => user('f'.repeat(100))),
      assistantCall('查一下', 'c1'),
      toolResult('结果', 'c1'),
      user('最后'),
    ]
    const out = compactMessages(msgs, { keepRecent: 3, budgetChars: 500 })
    const texts = out.map((m) => JSON.stringify(m))
    expect(texts.some((t) => t.includes('"c1"'))).toBe(true)
    expect(texts.filter((t) => t.includes('"c1"')).length).toBe(2)
  })

  it('★ 落在旧区的 toolCall 与 toolResult 必须同删（不留半对）', () => {
    const msgs = [
      user('目标'),
      assistantCall('查一下', 'c1'),
      toolResult('结果', 'c1'),
      ...Array.from({ length: 20 }, () => user('f'.repeat(100))),
      user('最后'),
    ]
    const out = compactMessages(msgs, { keepRecent: 3, budgetChars: 500 })
    const texts = out.map((m) => JSON.stringify(m))
    expect(texts.filter((t) => t.includes('"c1"')).length).toBe(0)
  })

  it('消息数少于 keepRecent 时不崩', () => {
    const msgs = [user('目标'), assistant('y'.repeat(5000))]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 1000 })
    expect(out[0]).toEqual(msgs[0])
  })

  it('空数组返回空数组', () => {
    expect(compactMessages([], { budgetChars: 1 })).toEqual([])
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

  it('★ 写入后可读回，路径与版本号正确', async () => {
    await saveMessageSnapshot(root, 'cs_abc', {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionId: 'cs_abc',
      runId: 'ar_1',
      messages: [user('你好')],
    })
    const back = await loadMessageSnapshot(root, 'cs_abc')
    expect(back?.messages).toHaveLength(1)
    expect(back?.version).toBe(1)
    expect(back?.sessionId).toBe('cs_abc')
    expect(messageSnapshotPath(root, 'cs_abc')).toContain(
      join('.inkloom', 'agent', 'sessions', 'cs_abc.messages.json'),
    )
  })

  it('没有快照时返回 null', async () => {
    expect(await loadMessageSnapshot(root, 'cs_none')).toBeNull()
  })

  it('★ 坏 JSON 与版本不符都返回 null（不把坏快照当历史）', async () => {
    const file = messageSnapshotPath(root, 'cs_bad')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'not json', 'utf8')
    expect(await loadMessageSnapshot(root, 'cs_bad')).toBeNull()
    await writeFile(file, JSON.stringify({ version: 2, messages: [] }), 'utf8')
    expect(await loadMessageSnapshot(root, 'cs_bad')).toBeNull()
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

  it('★ 含路径分隔符的 sessionId 直接拒绝（不能写出去）', () => {
    expect(() => messageSnapshotPath(root, '../evil')).toThrow(/非法会话 id/)
    expect(() => messageSnapshotPath(root, 'a/b')).toThrow(/非法会话 id/)
  })
})
