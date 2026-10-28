import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentPlan, AgentPlanTask } from '../api/types'
import { planTasksFrom } from './plan-view'

function task(id: string, status: AgentPlanTask['status']): AgentPlanTask {
  return {
    id,
    title: `任务 ${id}`,
    skill: 'chapter',
    brief: '略',
    review: 'none',
    status,
    artifacts: [],
    feedback: null,
    summary: null,
    reviewed: false,
  }
}

function planEvent(tasks: AgentPlanTask[]): AgentEvent {
  const plan: AgentPlan = {
    version: 1,
    id: 'p1',
    title: '计划',
    goal: 'g',
    status: 'approved',
    summary: null,
    feedback: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    tasks,
  }
  return { runId: 'ar_1', seq: 1, at: '2026-10-28T10:00:00.000Z', type: 'plan.updated', plan }
}

describe('planTasksFrom', () => {
  it('★ 空事件返回空数组', () => {
    expect(planTasksFrom([])).toEqual([])
  })

  it('★ 没有 plan.updated 返回空数组', () => {
    const events: AgentEvent[] = [
      { runId: 'ar_1', seq: 1, at: '2026-10-28T10:00:00.000Z', type: 'run.started', goal: 'g' },
    ]
    expect(planTasksFrom(events)).toEqual([])
  })

  it('★ 多个 plan.updated 取最后一次', () => {
    const events: AgentEvent[] = [
      planEvent([task('t1', 'todo')]),
      { runId: 'ar_1', seq: 2, at: '2026-10-28T10:01:00.000Z', type: 'ping' },
      planEvent([task('t1', 'done'), task('t2', 'doing')]),
    ]
    expect(planTasksFrom(events).map((t) => `${t.id}:${t.status}`)).toEqual(['t1:done', 't2:doing'])
  })
})
