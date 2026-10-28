import type { AgentEvent, AgentPlanTask } from '../api/types'

/**
 * 从事件流取最新一次 plan.updated 的任务列表。
 *
 * 为什么不回放 plan 的版本历史：作者在 trace 里想看的是「现在还剩什么没做」，
 * 中间每一次草稿级变更只是噪声。
 */
export function planTasksFrom(events: AgentEvent[]): AgentPlanTask[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e !== undefined && e.type === 'plan.updated') return e.plan.tasks
  }
  return []
}
