import { z } from 'zod'

// ---------------------------------------------------------------------------
// 共创计划：规划 → 执行 → 任务 → 自主完成
//
// ★ 定义与状态分家：
//   - 定义（story/plans/<id>.json）进 git，可审阅、可回滚；
//   - 状态（.inkloom/agent/plans/<id>.state.json）不进 git，
//     它每秒都在变，进版本历史只会把 diff 淹掉。
// ---------------------------------------------------------------------------

export const PLAN_SKILLS = ['world', 'characters', 'story', 'chapter', 'review', 'free'] as const
export type PlanSkill = (typeof PLAN_SKILLS)[number]
export const planSkillSchema = z.enum(PLAN_SKILLS)

export const TASK_STATUSES = ['todo', 'doing', 'done', 'skipped', 'blocked'] as const
export const taskStatusSchema = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof taskStatusSchema>

export const PLAN_STATUSES = [
  'drafting',
  'awaiting_approval',
  'approved',
  'done',
  'aborted',
] as const
export const planStatusSchema = z.enum(PLAN_STATUSES)
export type PlanStatus = z.infer<typeof planStatusSchema>

export const planTaskDefSchema = z.object({
  /** 稳定 id（小写 kebab）：状态文件与反馈都靠它对齐 */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'task id 用 小写 kebab-case，如 world-setting'),
  title: z.string().min(1).max(100),
  skill: planSkillSchema,
  brief: z.string().max(2000).default(''),
  review: z.enum(['required', 'none']).default('required'),
})
export type PlanTaskDef = z.infer<typeof planTaskDefSchema>

/** write_plan 的入参：不含 id/version/createdAt（由服务端生成） */
export const planDefSchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(4000),
  tasks: z.array(planTaskDefSchema).min(1).max(20),
})
export type PlanDefInput = z.infer<typeof planDefSchema>

/** 落盘的 plan 定义（story/plans/<id>.json，进 git） */
export const planDefFileSchema = planDefSchema.extend({
  version: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
})
export type PlanDef = z.infer<typeof planDefFileSchema>

export const planTaskStateSchema = z.object({
  id: z.string().min(1),
  status: taskStatusSchema.default('todo'),
  artifacts: z.array(z.string().min(1)).default([]),
  /** 打回意见；再次 request_review 时清空 */
  feedback: z.string().nullable().default(null),
  /** request_review 的摘要；approve/重做时清空 */
  summary: z.string().nullable().default(null),
  /** 作者是否已经通过这个任务的验收；重做时回到 false */
  reviewed: z.boolean().default(false),
})
export type PlanTaskState = z.infer<typeof planTaskStateSchema>

/** 落盘的状态（.inkloom/agent/plans/<id>.state.json，不进 git） */
export const planStateSchema = z.object({
  status: planStatusSchema.default('drafting'),
  /** 计划门禁的摘要 / 打回意见 */
  summary: z.string().nullable().default(null),
  feedback: z.string().nullable().default(null),
  tasks: z.array(planTaskStateSchema).default([]),
  updatedAt: z.string().datetime(),
})
export type PlanState = z.infer<typeof planStateSchema>

export const planTaskSchema = planTaskDefSchema.extend({
  status: taskStatusSchema,
  artifacts: z.array(z.string()),
  feedback: z.string().nullable(),
  summary: z.string().nullable(),
  reviewed: z.boolean(),
})
export type PlanTask = z.infer<typeof planTaskSchema>

/** 定义 + 状态合并后的运行时视图（API/UI/门禁都看它） */
export const planSchema = planDefFileSchema.extend({
  status: planStatusSchema,
  summary: z.string().nullable(),
  feedback: z.string().nullable(),
  tasks: z.array(planTaskSchema),
  updatedAt: z.string().datetime(),
})
export type Plan = z.infer<typeof planSchema>

/**
 * 合并定义与状态。
 *
 * ★ 状态里多出来的 id 直接忽略：计划被改过、任务被删掉时不能因此崩。
 * ★ 缺失的状态一律按 todo：宁可重做，也不要假装完成。
 */
export function mergePlan(def: PlanDef, state: PlanState | null): Plan {
  const byId = new Map((state?.tasks ?? []).map((t) => [t.id, t]))
  return {
    version: 1,
    id: def.id,
    title: def.title,
    goal: def.goal,
    createdAt: def.createdAt,
    status: state?.status ?? 'drafting',
    summary: state?.summary ?? null,
    feedback: state?.feedback ?? null,
    tasks: def.tasks.map((t) => {
      const s = byId.get(t.id)
      return {
        ...t,
        status: s?.status ?? 'todo',
        artifacts: s?.artifacts ?? [],
        feedback: s?.feedback ?? null,
        summary: s?.summary ?? null,
        reviewed: s?.reviewed ?? false,
      }
    }),
    updatedAt: state?.updatedAt ?? def.createdAt,
  }
}

/**
 * 下一个该做的任务：doing 优先（中断恢复），然后 todo，最后 blocked。
 * ★ skipped 不参与：作者跳过的事不能又被 Agent 捡回来做。
 */
export function nextOpenTask(plan: Plan): PlanTask | null {
  return (
    plan.tasks.find((t) => t.status === 'doing') ??
    plan.tasks.find((t) => t.status === 'todo') ??
    plan.tasks.find((t) => t.status === 'blocked') ??
    null
  )
}

/**
 * 完成 = 全部任务已做或已由作者跳过。
 * ★ skipped 也算有交代：否则点过「跳过」的计划永远停在 4/5，验收不了。
 */
export function isPlanComplete(plan: Plan): boolean {
  return plan.tasks.every((t) => t.status === 'done' || t.status === 'skipped')
}
