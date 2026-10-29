import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../api/types'
import { eventKey, mergeEvents } from './merge-events'

function ev(runId: string, seq: number, text = 'x'): AgentEvent {
  return { runId, seq, at: '2026-10-29T00:00:00.000Z', type: 'text.delta', text } as AgentEvent
}

const keys = (list: readonly AgentEvent[]): string[] => list.map(eventKey)

describe('eventKey', () => {
  it('run + seq 唯一标识一条事件', () => {
    expect(eventKey(ev('r1', 3))).toBe('r1:3')
    expect(eventKey(ev('r2', 3))).not.toBe(eventKey(ev('r1', 3)))
  })
})

describe('mergeEvents 快路径', () => {
  it('同一 run 的连续新事件直接追加', () => {
    const prev = [ev('r1', 1)]
    const merged = mergeEvents(prev, [ev('r1', 2), ev('r1', 3)])
    expect(keys(merged)).toEqual(['r1:1', 'r1:2', 'r1:3'])
    // 必须是新数组：返回同一个引用会让 React 跳过重渲染
    expect(merged).not.toBe(prev)
  })

  it('新 run 直接追加在老 run 后面', () => {
    const merged = mergeEvents([ev('r1', 1)], [ev('r2', 1), ev('r2', 2)])
    expect(keys(merged)).toEqual(['r1:1', 'r2:1', 'r2:2'])
  })

  it('空批次返回原引用（不制造无意义的重渲染）', () => {
    const prev = [ev('r1', 1)]
    expect(mergeEvents(prev, [])).toBe(prev)
  })
})

describe('mergeEvents 回放 / 乱序', () => {
  it('重连回放整段：按 key 去重，不重复堆 delta', () => {
    const prev = [ev('r1', 1), ev('r1', 2)]
    const replay = [ev('r1', 1), ev('r1', 2), ev('r1', 3)]
    expect(keys(mergeEvents(prev, replay))).toEqual(['r1:1', 'r1:2', 'r1:3'])
  })

  it('同一条事件重复投递只保留一条，内容以后到的为准', () => {
    const prev = [ev('r1', 1, '半')]
    const merged = mergeEvents(prev, [ev('r1', 1, '半句')])
    expect(merged).toHaveLength(1)
    expect((merged[0] as { text?: string }).text).toBe('半句')
  })

  it('中间补进来的事件按 seq 归位', () => {
    const merged = mergeEvents([ev('r1', 1), ev('r1', 3)], [ev('r1', 2)])
    expect(keys(merged)).toEqual(['r1:1', 'r1:2', 'r1:3'])
  })

  it('老 run 的迟到事件按 run 顺序归位，不会跑到新 run 后面', () => {
    const merged = mergeEvents([ev('r1', 1), ev('r2', 1)], [ev('r1', 2)])
    expect(keys(merged)).toEqual(['r1:1', 'r1:2', 'r2:1'])
  })
})
