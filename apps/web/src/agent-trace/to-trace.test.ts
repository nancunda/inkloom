import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSessionMeta } from '../api/types'
import { toTraceData } from './to-trace'

function ev(partial: Record<string, unknown>): AgentEvent {
  return {
    seq: 1,
    at: '2026-10-28T10:00:00.000Z',
    runId: 'ar_1',
    ...partial,
  } as unknown as AgentEvent
}

const meta: AgentSessionMeta = {
  id: 'cs_1',
  title: '测试会话',
  goal: '写开头',
  status: 'done',
  createdAt: '2026-10-28T09:59:00.000Z',
  updatedAt: '2026-10-28T10:05:00.000Z',
  tokens: 1200,
  steps: 9,
  subagentCalls: 1,
  planId: null,
  planTitle: null,
  planDone: 0,
  planTotal: 0,
  runIds: ['ar_1'],
  resumable: true,
}

describe('toTraceData', () => {
  it('★ run.started 成为根 span，user.message 成为作者 span', () => {
    const { traceRecord, spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: '写开头' }),
      ev({ type: 'user.message', text: '先派研究员' }),
    ])
    expect(traceRecord.id).toBe('cs_1')
    expect(spans).toHaveLength(1)
    expect(spans[0]?.type).toBe('agent_invocation')
    expect(spans[0]?.children?.some((c) => c.title.includes('作者'))).toBe(true)
  })

  it('★ 工具配对：started/ended 合成一个 timer，error 状态透传', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'tool.started', toolCallId: 't1', toolName: 'web_search', args: { query: '唐' } }),
      ev({
        type: 'tool.ended',
        toolCallId: 't1',
        toolName: 'web_search',
        isError: true,
        summary: '超时',
      }),
    ])
    const tool = spans[0]?.children?.find((c) => c.title.includes('联网搜索'))
    expect(tool?.type).toBe('tool_execution')
    expect(tool?.status).toBe('error')
    expect(tool?.output).toBe('超时')
  })

  it('★ 子体 partial → warning，output 用完整 text', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'subagent.started', id: 'sa_1', role: 'researcher', task: '查驿站' }),
      ev({
        type: 'subagent.tool',
        id: 'sa_1',
        role: 'researcher',
        toolCallId: 's1',
        toolName: 'web_search',
        ok: true,
        summary: '6 条',
        steps: 1,
      }),
      ev({
        type: 'subagent.ended',
        id: 'sa_1',
        role: 'researcher',
        ok: true,
        partial: true,
        steps: 8,
        tokens: 900,
        summary: '摘要',
        text: '完整结论内容',
        error: '步数上限（8 步）',
      }),
    ])
    const sub = spans[0]?.children?.find((c) => c.title.includes('研究员'))
    expect(sub?.status).toBe('warning')
    expect(sub?.output).toBe('完整结论内容')
    expect(sub?.children).toHaveLength(1)
  })

  it('★ 第二个 run.started 变成「继续对话」事件，不新建根 span', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'run.finished', runId: 'ar_1', seq: 2 }),
      ev({ type: 'run.started', goal: '继续', runId: 'ar_2', seq: 1 }),
    ])
    expect(spans).toHaveLength(1)
    expect(spans[0]?.children?.some((c) => c.title.includes('继续对话'))).toBe(true)
  })

  it('★ 未知事件落到 span 兜底，不丢信息', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'something.new', foo: 1 }),
    ])
    const child = spans[0]?.children?.find((c) => c.type === 'span')
    expect(child?.raw[0]).toContain('something.new')
  })
})
