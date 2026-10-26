import type { Plan } from '@inkloom/shared'

/**
 * 门禁 = 从 plan 投影出来的「现在等作者拍板什么」。
 *
 * ★ 唯一来源：不再让工具/提示词各自决定「什么时候该停」。
 *   工具只改 plan 状态；drive 结束后用 deriveGate(plan) 对账。
 *   这样重启、续聊、打回都不会出现「UI 有门禁、plan 里没有」的错位。
 */
export type AgentGate =
  | {
      kind: 'plan'
      planId: string
      title: string
      summary: string
      artifacts: string[]
    }
  | {
      kind: 'task'
      planId: string
      taskId: string
      title: string
      summary: string
      artifacts: string[]
    }

export function deriveGate(plan: Plan): AgentGate | null {
  if (plan.status === 'awaiting_approval') {
    return {
      kind: 'plan',
      planId: plan.id,
      title: plan.title,
      summary: plan.summary ?? '计划等待作者批准',
      artifacts: [],
    }
  }
  // 任务门禁：完成 + 需要审阅 + 还没被作者通过
  const task = plan.tasks.find((t) => t.status === 'done' && t.review === 'required' && !t.reviewed)
  if (task !== undefined) {
    return {
      kind: 'task',
      planId: plan.id,
      taskId: task.id,
      title: task.title,
      summary: task.summary ?? `任务「${task.title}」完成，等待审阅`,
      artifacts: task.artifacts,
    }
  }
  return null
}
