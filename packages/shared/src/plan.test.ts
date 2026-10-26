import { describe, expect, it } from 'vitest'
import { isPlanComplete, mergePlan, nextOpenTask, type PlanDef, planDefSchema } from './plan.js'

const def: PlanDef = {
  version: 1,
  id: 'plan-test',
  title: '开篇计划',
  goal: '把书搭起来',
  createdAt: '2026-10-26T00:00:00.000Z',
  tasks: [
    {
      id: 'world',
      title: '世界',
      skill: 'world',
      brief: '规则与地点',
      review: 'required',
    },
    {
      id: 'chapter-1',
      title: '第 1 章',
      skill: 'chapter',
      brief: '写出初稿',
      review: 'none',
    },
  ],
}

describe('mergePlan', () => {
  it('没有状态时全部按 todo / drafting', () => {
    const plan = mergePlan(def, null)
    expect(plan.status).toBe('drafting')
    expect(plan.tasks.map((t) => t.status)).toEqual(['todo', 'todo'])
    expect(plan.tasks[0]?.reviewed).toBe(false)
  })

  it('按 id 合并状态；状态里多出来的 id 被忽略', () => {
    const plan = mergePlan(def, {
      status: 'approved',
      summary: null,
      feedback: null,
      updatedAt: '2026-10-26T01:00:00.000Z',
      tasks: [
        {
          id: 'world',
          status: 'done',
          artifacts: ['world/rules.json'],
          feedback: null,
          summary: '写完了',
          reviewed: true,
        },
        {
          id: 'ghost',
          status: 'done',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: true,
        },
      ],
    })
    expect(plan.status).toBe('approved')
    expect(plan.tasks[0]?.status).toBe('done')
    expect(plan.tasks[0]?.reviewed).toBe(true)
    expect(plan.tasks[1]?.status).toBe('todo')
    expect(plan.tasks).toHaveLength(2)
  })
})

describe('nextOpenTask / isPlanComplete', () => {
  it('doing 优先（中断恢复），其次 todo、blocked', () => {
    const plan = mergePlan(def, {
      status: 'approved',
      summary: null,
      feedback: null,
      updatedAt: '2026-10-26T01:00:00.000Z',
      tasks: [
        {
          id: 'world',
          status: 'blocked',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: false,
        },
        {
          id: 'chapter-1',
          status: 'doing',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: false,
        },
      ],
    })
    expect(nextOpenTask(plan)?.id).toBe('chapter-1')
    expect(isPlanComplete(plan)).toBe(false)
  })

  it('全部 done 才算完成', () => {
    const plan = mergePlan(def, {
      status: 'approved',
      summary: null,
      feedback: null,
      updatedAt: '2026-10-26T01:00:00.000Z',
      tasks: [
        {
          id: 'world',
          status: 'done',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: true,
        },
        {
          id: 'chapter-1',
          status: 'done',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: true,
        },
      ],
    })
    expect(isPlanComplete(plan)).toBe(true)
    expect(nextOpenTask(plan)).toBeNull()
  })

  it('★ 跳过算有交代：全 done/skipped 即完成，且 skipped 不会被再捡起来', () => {
    const plan = mergePlan(def, {
      status: 'approved',
      summary: null,
      feedback: null,
      updatedAt: '2026-10-26T01:00:00.000Z',
      tasks: [
        {
          id: 'world',
          status: 'done',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: true,
        },
        {
          id: 'chapter-1',
          status: 'skipped',
          artifacts: [],
          feedback: null,
          summary: null,
          reviewed: true,
        },
      ],
    })
    expect(isPlanComplete(plan)).toBe(true)
    expect(nextOpenTask(plan)).toBeNull()
  })
})

describe('planDefSchema', () => {
  it('任务 id 必须是小写 kebab，review 默认 required', () => {
    const parsed = planDefSchema.parse({
      title: 't',
      goal: 'g',
      tasks: [{ id: 'world-setting', title: '世界', skill: 'world' }],
    })
    expect(parsed.tasks[0]?.review).toBe('required')
    expect(() =>
      planDefSchema.parse({
        title: 't',
        goal: 'g',
        tasks: [{ id: 'World Setting', title: '世界', skill: 'world' }],
      }),
    ).toThrow()
  })
})
