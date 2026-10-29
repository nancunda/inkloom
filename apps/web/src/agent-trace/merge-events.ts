import type { AgentEvent } from '../api/types'

/**
 * 事件合并：SSE 与 journal 两条来源、以及重连回放都会重复投递同一事件。
 *
 * ★ 为什么不能直接替换：journal 不记录 delta（persist=false），而 SSE 建连时
 *   会从头回放整段 run.events（含 delta）。整体替换会抹掉刚 append 的 delta，
 *   重复追加又会把回放的 delta 堆到树尾——只能按 key 合并。
 * ★ 快路径很重要：运行中每帧都有新事件，绝大多数是「同一个 run 的下一个 seq」，
 *   直接追加即可；只有重连回放/乱序才走全量排序。
 */
export function eventKey(e: AgentEvent): string {
  return `${e.runId}:${e.seq}`
}

function isAppendOnly(prev: readonly AgentEvent[], incoming: readonly AgentEvent[]): boolean {
  if (prev.length === 0) return true
  const last = prev[prev.length - 1]
  const first = incoming[0]
  if (last === undefined || first === undefined) return true
  if (first.runId === last.runId) {
    if (first.seq <= last.seq) return false
    // 同一 run 内必须递增（delta 是流式追加，正常不会乱序）
    for (let i = 1; i < incoming.length; i += 1) {
      const prevEv = incoming[i - 1]
      const nextEv = incoming[i]
      if (prevEv === undefined || nextEv === undefined) return false
      if (nextEv.runId !== prevEv.runId || nextEv.seq <= prevEv.seq) return false
    }
    return true
  }
  // 换了一个 run：只有在 prev 里从没出现过这个 runId 时才能直接追加
  return !prev.some((e) => e.runId === first.runId)
}

export function mergeEvents(
  prev: readonly AgentEvent[],
  incoming: readonly AgentEvent[],
): AgentEvent[] {
  if (incoming.length === 0) return prev as AgentEvent[]
  if (isAppendOnly(prev, incoming)) return [...prev, ...incoming]

  const map = new Map<string, AgentEvent>()
  const runOrder: string[] = []
  for (const e of [...prev, ...incoming]) {
    if (!runOrder.includes(e.runId)) runOrder.push(e.runId)
    map.set(eventKey(e), e)
  }
  const rank = new Map(runOrder.map((id, i) => [id, i]))
  return [...map.values()].sort((a, b) => {
    const ra = rank.get(a.runId) ?? 0
    const rb = rank.get(b.runId) ?? 0
    return ra === rb ? a.seq - b.seq : ra - rb
  })
}
