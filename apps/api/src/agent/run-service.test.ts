import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { PlanDef, PlanStatus, TaskStatus } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPlan,
  readCurrentPlan,
  setCurrentPlan,
  writePlanDef,
  writePlanState,
} from '../storage/plans.js'
import { loadMessageSnapshot, saveMessageSnapshot } from './history.js'
import { readSessionMeta, writeSessionMeta } from './session-store.js'

interface FakeEvent {
  type: string
  message?: unknown
}

interface FakeTool {
  name: string
  execute: (id: string, params: unknown) => Promise<unknown>
}

interface FakeAgent {
  opts: {
    initialState: { tools: FakeTool[]; messages?: { role?: string }[] }
    transformContext?: (messages: unknown[]) => Promise<unknown[]>
  }
  state: { errorMessage?: string; messages: unknown[] }
  promptCalls: number
  prompts: string[]
  steers: string[]
  fail: () => void
  done: () => void
  emit: (e: FakeEvent) => void
}

// vi.mock 工厂会被提升到 import 之前，共享状态必须用 vi.hoisted 创建
const h = vi.hoisted(() => ({
  root: '',
  currentRoot: '',
  agents: [] as FakeAgent[],
}))

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgentImpl {
    opts: {
      initialState: { tools: FakeTool[]; messages?: { role?: string }[] }
      transformContext?: (messages: unknown[]) => Promise<unknown[]>
    }
    state: { errorMessage?: string; messages: unknown[] } = { messages: [] }
    promptCalls = 0
    prompts: string[] = []
    steers: string[] = []
    listeners: ((e: FakeEvent) => void)[] = []
    resolvers: (() => void)[] = []
    rejecters: ((e: Error) => void)[] = []

    constructor(opts: { initialState: { tools: FakeTool[] } }) {
      this.opts = opts
      h.agents.push(this as unknown as FakeAgent)
    }

    subscribe(cb: (e: FakeEvent) => void): () => void {
      this.listeners.push(cb)
      return () => {
        this.listeners = this.listeners.filter((l) => l !== cb)
      }
    }

    /** 永不主动 resolve：测试自己控制「模型还在跑」与「运行结束」的时序 */
    prompt(prompt?: string): Promise<void> {
      this.promptCalls += 1
      this.prompts.push(String(prompt))
      return new Promise<void>((resolve, reject) => {
        this.resolvers.push(resolve)
        this.rejecters.push(reject)
      })
    }

    /** 模型这一轮正常结束（agent_end 之后 prompt 才 resolve） */
    done(): void {
      const resolve = this.resolvers.pop()
      resolve?.()
    }

    fail(): void {
      const reject = this.rejecters.pop()
      reject?.(new Error('模型调用失败'))
    }

    abort(): void {
      const resolve = this.resolvers.pop()
      resolve?.()
    }

    steer(message: { content: unknown }): void {
      this.steers.push(String(message.content))
    }

    emit(e: FakeEvent): void {
      for (const l of this.listeners) l(e)
    }
  }
  return { Agent: FakeAgentImpl }
})

const projectFixture = () => ({
  id: 'proj_unit',
  folderId: 'folder_unit',
  rootPath: h.root,
  name: '测试书',
  genre: '玄幻',
  status: 'writing',
})

vi.mock('../services/context.js', () => ({
  getContext: () => ({ root: h.root, project: projectFixture() }),
  peekContext: () => ({ root: h.currentRoot, project: projectFixture() }),
}))

const {
  clearRuns,
  criticSkipReason,
  getAgentRun,
  hasLiveAgentRun,
  resetRunsForTest,
  resumeAgentRun,
  resumeSession,
  reviewAgentRun,
  sendAgentMessage,
  startAgentRun,
  startSession,
  stopAgentRun,
} = await import('./run-service.js')

function lastAgent(): FakeAgent {
  const agent = h.agents.at(-1)
  if (agent === undefined) throw new Error('没有创建 Agent')
  return agent
}

function findTool(agent: FakeAgent, name: string): FakeTool {
  const tool = agent.opts.initialState.tools.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`找不到工具 ${name}`)
  return tool
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 80))

interface TaskSpec {
  id: string
  status: TaskStatus
  review?: 'required' | 'none'
  reviewed?: boolean
  feedback?: string | null
}

/** 直接落一份 plan（定义 + 状态 + 指针），模拟“已有计划”的书 */
async function seedPlan(
  status: PlanStatus,
  tasks: TaskSpec[],
  summary: string | null = null,
): Promise<string> {
  const id = 'plan-test01'
  const ts = new Date().toISOString()
  const def: PlanDef = {
    version: 1,
    id,
    title: '测试计划',
    goal: '把书搭起来',
    createdAt: ts,
    tasks: tasks.map((t, i) => ({
      id: t.id,
      title: `任务 ${i + 1}`,
      skill: 'world',
      brief: '写点东西',
      review: t.review ?? 'required',
    })),
  }
  await writePlanDef(h.root, def)
  await writePlanState(h.root, id, {
    status,
    summary,
    feedback: null,
    updatedAt: ts,
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      artifacts: [],
      feedback: t.feedback ?? null,
      summary: null,
      reviewed: t.reviewed ?? false,
    })),
  })
  await setCurrentPlan(h.root, id)
  return id
}

/** 计划门禁：agent 提交计划 → agent_end → waiting_review */
async function reachPlanGate(): Promise<{ id: string; agent: FakeAgent; planId: string }> {
  const planId = await seedPlan('drafting', [{ id: 't1', status: 'todo' }])
  const started = await startAgentRun('开始')
  const agent = lastAgent()
  await findTool(agent, 'request_review').execute('c1', {
    kind: 'plan',
    summary: '请批准计划',
  })
  agent.emit({ type: 'agent_end' })
  agent.done()
  await tick()
  expect(getAgentRun(started.id)?.status).toBe('waiting_review')
  return { id: started.id, agent, planId }
}

/** 任务门禁：批准的计划正在做 t1，agent 做完并请求审阅 */
async function reachTaskGate(): Promise<{ id: string; agent: FakeAgent; planId: string }> {
  const planId = await seedPlan('approved', [
    { id: 't1', status: 'doing' },
    { id: 't2', status: 'todo' },
  ])
  const started = await startAgentRun('继续')
  const agent = lastAgent()
  await findTool(agent, 'update_task').execute('c1', {
    taskId: 't1',
    status: 'done',
    artifacts: [],
  })
  await findTool(agent, 'request_review').execute('c2', {
    kind: 'task',
    taskId: 't1',
    summary: '任务 1 做完了',
  })
  agent.emit({ type: 'agent_end' })
  agent.done()
  await tick()
  expect(getAgentRun(started.id)?.status).toBe('waiting_review')
  return { id: started.id, agent, planId }
}

beforeEach(async () => {
  h.agents.length = 0
  h.root = await mkdtemp(join(tmpdir(), 'inkloom-agent-unit-'))
  h.currentRoot = h.root
  process.env['DEEPSEEK_API_KEY'] = 'sk-test'
  // 默认 critic=on 会真的起一个子 Agent（FakeAgent 永不自动结束），这里统一关掉；
  // 需要 critic 的用例自己打开。
  process.env['INKLOOM_CRITIC'] = 'off'
})

afterEach(async () => {
  delete process.env['DEEPSEEK_API_KEY']
  delete process.env['INKLOOM_CRITIC']
  await new Promise((r) => setTimeout(r, 20))
  resetRunsForTest()
  await rm(h.root, { recursive: true, force: true }).catch(() => undefined)
})

describe('计划门禁', () => {
  it('★ 计划通过 → approved，并自动开始第一个任务', async () => {
    const { id, agent, planId } = await reachPlanGate()
    expect(agent.promptCalls).toBe(1)

    const reviewed = await reviewAgentRun(id, 'approve', null)

    const plan = await loadPlan(h.root, planId)
    expect(plan?.status).toBe('approved')
    expect(agent.promptCalls).toBe(2)
    expect(reviewed.events.map((e) => e.type)).toContain('gate.resolved')
    stopAgentRun(id)
  })

  it('计划打回 → 回到 drafting，带意见重新规划', async () => {
    const { id, agent, planId } = await reachPlanGate()

    await reviewAgentRun(id, 'revise', '任务太粗，拆细一点')

    const plan = await loadPlan(h.root, planId)
    expect(plan?.status).toBe('drafting')
    expect(plan?.feedback).toBe('任务太粗，拆细一点')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('★ 全部任务完成后通过计划 = 本轮结束（不再续跑）', async () => {
    const planId = await seedPlan('awaiting_approval', [
      { id: 't1', status: 'done', reviewed: true },
    ])
    const started = await startAgentRun('验收')
    const agent = lastAgent()

    // 恢复等待批准：不叫模型
    expect(agent.promptCalls).toBe(0)
    expect(getAgentRun(started.id)?.gate?.kind).toBe('plan')

    const reviewed = await reviewAgentRun(started.id, 'approve', null)

    expect(reviewed.status).toBe('done')
    expect(reviewed.finishedAt).not.toBeNull()
    expect((await loadPlan(h.root, planId))?.status).toBe('done')
    expect(agent.promptCalls).toBe(0)
  })
})

describe('任务门禁', () => {
  it('★ 任务通过 → 自动开始下一个任务', async () => {
    const { id, agent, planId } = await reachTaskGate()
    expect(agent.promptCalls).toBe(1)

    await reviewAgentRun(id, 'approve', null)

    const plan = await loadPlan(h.root, planId)
    expect(plan?.tasks.find((t) => t.id === 't1')?.reviewed).toBe(true)
    expect(plan?.tasks.find((t) => t.id === 't2')?.status).toBe('todo')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('任务打回 → 回到 doing，意见写进任务', async () => {
    const { id, agent, planId } = await reachTaskGate()

    await reviewAgentRun(id, 'revise', '规则太抽象，要能执行')

    const plan = await loadPlan(h.root, planId)
    const task = plan?.tasks.find((t) => t.id === 't1')
    expect(task?.status).toBe('doing')
    expect(task?.reviewed).toBe(false)
    expect(task?.feedback).toBe('规则太抽象，要能执行')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('★ 跳过任务 → 记为 skipped 并自动开始下一个任务', async () => {
    const { id, agent, planId } = await reachTaskGate()

    await reviewAgentRun(id, 'skip', null)

    const plan = await loadPlan(h.root, planId)
    const task = plan?.tasks.find((t) => t.id === 't1')
    expect(task?.status).toBe('skipped')
    expect(task?.reviewed).toBe(true)
    expect(plan?.tasks.find((t) => t.id === 't2')?.status).toBe('todo')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('review=none 的任务不产生门禁', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing', review: 'none' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    await findTool(agent, 'update_task').execute('c1', {
      taskId: 't1',
      status: 'done',
      artifacts: [],
    })
    agent.emit({ type: 'agent_end' })
    agent.done()
    await tick()

    const plan = await loadPlan(h.root, planId)
    expect(plan?.tasks[0]?.reviewed).toBe(true)
    // 没有任务门禁；全部完成后自动推进到「请作者验收」
    expect(getAgentRun(started.id)?.gate).toBeNull()
    stopAgentRun(started.id)
  })
})

describe('门禁回归', () => {
  it('★ 批准计划后，任务结束时不会重复投出旧计划门禁（gateBox 消费即清空）', async () => {
    const planId = await seedPlan('drafting', [
      { id: 't1', status: 'todo', review: 'none' },
      { id: 't2', status: 'todo' },
    ])
    const started = await startAgentRun('开始')
    const agent = lastAgent()
    await findTool(agent, 'request_review').execute('c1', { kind: 'plan', summary: '请批准' })
    agent.emit({ type: 'agent_end' })
    agent.done()
    await tick()

    await reviewAgentRun(started.id, 'approve', null)
    // 批准后开始 t1（prompt #2）
    expect(agent.promptCalls).toBe(2)

    // t1 完成，本轮正常结束：旧 gateBox 不能把 plan 门禁再投一次
    await findTool(agent, 'update_task').execute('c2', {
      taskId: 't1',
      status: 'done',
      artifacts: [],
    })
    agent.emit({ type: 'agent_end' })
    agent.done()
    await settle()

    const snap = getAgentRun(started.id)
    expect(snap?.status).toBe('running')
    expect(snap?.gate).toBeNull()
    expect(agent.promptCalls).toBe(3)
    expect((await loadPlan(h.root, planId))?.tasks[1]?.status).toBe('todo')
    stopAgentRun(started.id)
  })
})

describe('中止终态', () => {
  it('★ 停止：doing → blocked，已批准的计划 → aborted', async () => {
    const planId = await seedPlan('approved', [
      { id: 't1', status: 'doing' },
      { id: 't2', status: 'todo' },
    ])
    const started = await startAgentRun('继续')

    stopAgentRun(started.id)
    await new Promise((r) => setTimeout(r, 80))

    const plan = await loadPlan(h.root, planId)
    expect(plan?.status).toBe('aborted')
    expect(plan?.tasks.find((t) => t.id === 't1')?.status).toBe('blocked')
  })

  it('★ 步数耗尽且还有任务 → paused，任务保持 doing 可继续', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const run = getAgentRun(started.id)
    if (run !== null) run.budget.steps = run.budget.maxSteps
    agent.emit({ type: 'agent_end' })
    agent.done()
    await new Promise((r) => setTimeout(r, 80))

    const after = getAgentRun(started.id)
    expect(after?.status).toBe('paused')
    expect(after?.error).toBeNull()
    expect((await loadPlan(h.root, planId))?.status).toBe('approved')
    expect((await loadPlan(h.root, planId))?.tasks[0]?.status).toBe('doing')
  })

  it('★ 暂停后可以继续：步数清零，任务从 doing 接着做', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const run = getAgentRun(started.id)
    if (run !== null) run.budget.steps = run.budget.maxSteps
    agent.emit({ type: 'agent_end' })
    agent.done()
    await new Promise((r) => setTimeout(r, 80))

    const before = agent.promptCalls
    const resumed = resumeAgentRun(started.id)
    expect(resumed.status).toBe('running')
    expect(resumed.budget.steps).toBe(0)
    expect(resumed.planId).toBe(planId)

    await new Promise((r) => setTimeout(r, 80))
    expect(agent.promptCalls).toBe(before + 1)
    expect(agent.prompts.at(-1)).toContain('任务 t1')
    stopAgentRun(started.id)
  })

  it('★ 步数耗尽 + 任务全部完成 → 也是 paused，不再空转请验收', async () => {
    await seedPlan('approved', [{ id: 't1', status: 'done', reviewed: true }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const before = agent.promptCalls
    const run = getAgentRun(started.id)
    if (run !== null) run.budget.steps = run.budget.maxSteps
    agent.emit({ type: 'agent_end' })
    agent.done()
    await new Promise((r) => setTimeout(r, 80))

    const after = getAgentRun(started.id)
    expect(after?.status).toBe('paused')
    // ★ 不能再 drive 一次：beforeToolCall 会拦住 request_review，会无限烧 token
    expect(agent.promptCalls).toBe(before)
  })

  it('★ 暂停时发消息被拒（只能点「继续执行」）', async () => {
    await seedPlan('approved', [{ id: 't1', status: 'done', reviewed: true }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const run = getAgentRun(started.id)
    if (run !== null) run.budget.steps = run.budget.maxSteps
    agent.emit({ type: 'agent_end' })
    agent.done()
    await new Promise((r) => setTimeout(r, 80))
    expect(getAgentRun(started.id)?.status).toBe('paused')

    expect(() => sendAgentMessage(started.id, '再改一下')).toThrow(/已暂停/)
  })

  it('★ 模型连续多轮不调工具也不改计划 → paused，不再无限空转', async () => {
    await seedPlan('approved', [{ id: 't1', status: 'done', reviewed: true }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    expect(agent.promptCalls).toBe(1)

    const endOnce = async (): Promise<void> => {
      agent.emit({ type: 'agent_end' })
      agent.done()
      await new Promise((r) => setTimeout(r, 80))
    }

    // 第一轮：没调工具、计划也没变 → 推一把；再推一次仍不动 → 停给作者
    await endOnce()
    expect(agent.promptCalls).toBe(2)
    await endOnce()
    expect(agent.promptCalls).toBe(3)
    await endOnce()

    expect(getAgentRun(started.id)?.status).toBe('paused')
    expect(agent.promptCalls).toBe(3)
  })

  it('★ 还有任务但多轮不调工具 → 也 paused（不只管任务全完成）', async () => {
    await seedPlan('approved', [{ id: 't1', status: 'todo' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    expect(agent.promptCalls).toBe(1)

    const endOnce = async (): Promise<void> => {
      agent.emit({ type: 'agent_end' })
      agent.done()
      await new Promise((r) => setTimeout(r, 80))
    }

    await endOnce()
    expect(agent.promptCalls).toBe(2)
    await endOnce()
    expect(agent.promptCalls).toBe(3)
    await endOnce()

    expect(getAgentRun(started.id)?.status).toBe('paused')
    expect(agent.promptCalls).toBe(3)
  })
})

describe('review 基本校验', () => {
  it('不在等待审阅时拒绝 review', async () => {
    const started = await startAgentRun('测试目标')
    await expect(reviewAgentRun(started.id, 'approve', null)).rejects.toThrow(
      '这个 run 现在不在等待审阅',
    )
    stopAgentRun(started.id)
  })

  it('打回必须带意见', async () => {
    const { id } = await reachPlanGate()
    await expect(reviewAgentRun(id, 'revise', '  ')).rejects.toThrow('打回必须写清楚要改什么')
    stopAgentRun(id)
  })

  it('★ 计划门禁不能跳过', async () => {
    const { id } = await reachPlanGate()
    await expect(reviewAgentRun(id, 'skip', null)).rejects.toThrow('计划门禁不能跳过')
    // 报错不能把门禁吞掉：作者还得能批准或打回
    expect(getAgentRun(id)?.status).toBe('waiting_review')
    expect(getAgentRun(id)?.gate?.kind).toBe('plan')
    stopAgentRun(id)
  })
})

describe('归属与清理（切书安全）', () => {
  it('★ run 只属于创建它的书：换书后不可读、不可续聊', async () => {
    const started = await startAgentRun('测试目标')
    h.currentRoot = join(h.root, 'other-book')

    expect(getAgentRun(started.id)).toBeNull()
    expect(() => sendAgentMessage(started.id, '继续')).toThrow('不存在')

    h.currentRoot = h.root
    expect(getAgentRun(started.id)?.status).toBe('running')
    stopAgentRun(started.id)
  })

  it('hasLiveAgentRun 反映占用状态；clearRuns 只清已结束的 run', async () => {
    const started = await startAgentRun('测试目标')
    expect(hasLiveAgentRun()).toBe(true)

    clearRuns()
    expect(getAgentRun(started.id)?.status).toBe('running')

    stopAgentRun(started.id)
    expect(hasLiveAgentRun()).toBe(false)
    expect(clearRuns()).toBe(1)
    expect(getAgentRun(started.id)).toBeNull()
  })
})

describe('继续执行与重新规划', () => {
  it('★ 继续执行：aborted 计划改回 approved，从 blocked 任务接着做', async () => {
    const planId = await seedPlan('approved', [
      { id: 't1', status: 'doing' },
      { id: 't2', status: 'todo' },
    ])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    stopAgentRun(started.id)
    await settle()
    expect((await loadPlan(h.root, planId))?.status).toBe('aborted')

    const before = agent.promptCalls
    resumeAgentRun(started.id)
    await settle()

    const plan = await loadPlan(h.root, planId)
    expect(plan?.status).toBe('approved')
    expect(plan?.tasks.find((t) => t.id === 't1')?.status).toBe('blocked')
    expect(agent.promptCalls).toBe(before + 1)
    stopAgentRun(started.id)
  })

  it('★ 重新规划：旧计划作废，新 run 不接旧计划', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const first = await startAgentRun('继续')
    stopAgentRun(first.id)
    await settle()
    expect((await loadPlan(h.root, planId))?.status).toBe('aborted')

    const replanned = await startAgentRun('重新来一份计划', { mode: 'replan' })
    expect(replanned.planId).toBeNull()
    expect(replanned.status).toBe('running')
    expect((await loadPlan(h.root, planId))?.status).toBe('aborted')
    expect(lastAgent().prompts.at(-1)).toContain('重新规划')
    stopAgentRun(replanned.id)
  })

  it('★ 开始新计划：不接旧计划，并把作者目标写进提示词', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const prior = await startAgentRun('继续')
    stopAgentRun(prior.id)
    await settle()

    const started = await startAgentRun('只规划 3 个只读校对任务，不要生成正文', { mode: 'new' })

    expect(started.planId).toBeNull()
    expect((await loadPlan(h.root, planId))?.status).toBe('aborted')
    expect(await readCurrentPlan(h.root)).toBeNull()
    expect(lastAgent().prompts.at(-1)).toContain('只规划 3 个只读校对任务')
    stopAgentRun(started.id)
  })

  it('★ 继续执行（无内存 run）：aborted 计划被救回 approved，从 blocked 任务继续', async () => {
    const planId = await seedPlan('aborted', [
      { id: 't1', status: 'blocked' },
      { id: 't2', status: 'todo' },
    ])

    const started = await startAgentRun('继续执行计划里没做完的任务', { mode: 'resume' })

    expect(started.planId).toBe(planId)
    expect(getAgentRun(started.id)?.status).toBe('running')
    const plan = await loadPlan(h.root, planId)
    expect(plan?.status).toBe('approved')
    expect(plan?.tasks[0]?.status).toBe('blocked')
    expect(lastAgent().prompts.at(-1)).toContain('任务 1')
    stopAgentRun(started.id)
  })
})

describe('sendAgentMessage（对话式共创）', () => {
  it('运行中发消息 → steer 到当前轮之后', async () => {
    const started = await startAgentRun('测试目标')
    const agent = lastAgent()

    sendAgentMessage(started.id, '顺便看一下节奏')

    expect(agent.steers).toEqual(['顺便看一下节奏'])
    stopAgentRun(started.id)
  })

  it('★ 等待审阅时发消息 = 带意见打回', async () => {
    const { id, agent, planId } = await reachPlanGate()

    sendAgentMessage(id, '把第 2 个任务拆成两半')
    await settle()

    const plan = await loadPlan(h.root, planId)
    expect(plan?.status).toBe('drafting')
    expect(plan?.feedback).toBe('把第 2 个任务拆成两半')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('本轮结束后还能接着聊（同一段 transcript）', async () => {
    const planId = await seedPlan('awaiting_approval', [
      { id: 't1', status: 'done', reviewed: true },
    ])
    const started = await startAgentRun('验收')
    const agent = lastAgent()
    await reviewAgentRun(started.id, 'approve', null)
    expect(getAgentRun(started.id)?.status).toBe('done')

    sendAgentMessage(started.id, '第 1 章能不能更狠一点')
    await tick()

    expect(agent.promptCalls).toBe(1)
    expect(getAgentRun(started.id)?.status).toBe('running')
    expect((await loadPlan(h.root, planId))?.status).toBe('done')
    stopAgentRun(started.id)
  })

  it('失败的 run 不再接收消息', async () => {
    const started = await startAgentRun('测试目标')
    const agent = lastAgent()
    agent.fail()
    await tick()
    expect(getAgentRun(started.id)?.status).toBe('failed')
    expect(() => sendAgentMessage(started.id, '再试一次')).toThrow('失败了')
  })
})

describe('子智能体事件', () => {
  it('★ delegate 的子体事件进 run 事件流，token 与调用次数都记账', async () => {
    await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const pending = findTool(agent, 'delegate').execute('c1', {
      role: 'researcher',
      task: '查唐代驿站制度',
    })
    await tick()

    const child = lastAgent()
    expect(child).not.toBe(agent)
    child.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '查到 2 条资料' }],
        usage: { input: 10, output: 5 },
      },
    })
    child.emit({ type: 'agent_end' })
    child.done()

    const result = (await pending) as { isError?: boolean }
    expect(result.isError).toBeFalsy()

    const snap = getAgentRun(started.id)
    const types = (snap?.events ?? []).map((e) => e.type).filter((t) => t.startsWith('subagent.'))
    expect(types).toEqual(['subagent.started', 'subagent.ended'])
    expect(snap?.tokens).toBe(15)
    expect(snap?.budget.subagentCalls).toBe(1)
    stopAgentRun(started.id)
  })

  it('★ INKLOOM_CRITIC=on 时空产物被门禁拦下（不创建子体）', async () => {
    process.env['INKLOOM_CRITIC'] = 'on'
    await seedPlan('approved', [{ id: 't1', status: 'doing', review: 'none' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const pending = findTool(agent, 'update_task').execute('c1', {
      taskId: 't1',
      status: 'done',
      artifacts: [],
    })
    await tick()

    // 没有产物 → 门禁直接拦下，不创建子体
    const result = (await pending) as { isError?: boolean }
    expect(result.isError).toBe(true)
    expect(h.agents).toHaveLength(1)
    stopAgentRun(started.id)
  })
})

describe('会话绑定', () => {
  it('★ 事件带 runId，快照带 sessionId', async () => {
    const started = await startAgentRun('目标', { mode: 'new' })
    expect(started.sessionId).toMatch(/^cs_/)
    const snap = getAgentRun(started.id)
    expect(snap?.sessionId).toBe(started.sessionId)
    expect(snap?.events.every((e) => e.runId === started.id)).toBe(true)
    stopAgentRun(started.id)
  })

  it('★ 会话在磁盘上留下 meta 与 messages 快照', async () => {
    const started = await startAgentRun('目标', { mode: 'new' })
    const agent = lastAgent()
    agent.state.messages.push({ role: 'user', content: '你好', timestamp: 1 })
    agent.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
    })
    agent.emit({ type: 'agent_end' })
    agent.done()
    await vi.waitFor(async () => {
      const meta = await readSessionMeta(h.root, started.sessionId)
      expect(meta?.title).toBe('目标')
      expect(meta?.status).toBe('done')
    })
    const snap = await loadMessageSnapshot(h.root, started.sessionId)
    expect(snap?.messages.length).toBeGreaterThan(0)
  })

  it('★ 续接时历史消息进入 Agent，旧 system 被剥掉', async () => {
    const started = await startAgentRun('续', {
      mode: 'resume',
      sessionId: 'cs_abc123def456',
      messages: [
        { role: 'system', content: '旧提示词', timestamp: 0 } as unknown as AgentMessage,
        { role: 'user', content: '上一轮', timestamp: 1 } as unknown as AgentMessage,
      ],
    })
    const agent = lastAgent()
    expect(agent.opts.initialState.messages?.[0]?.role).toBe('user')
    stopAgentRun(started.id)
  })

  it('★ transformContext 只保留一份 system', async () => {
    const started = await startAgentRun('目标', { mode: 'new' })
    const agent = lastAgent()
    const out = await agent.opts.transformContext?.([
      { role: 'system', content: 'sys', timestamp: 0 },
      { role: 'user', content: 'u', timestamp: 1 },
    ])
    const systems = (out ?? []).filter((m) => (m as { role?: string }).role === 'system')
    expect(systems).toHaveLength(1)
    stopAgentRun(started.id)
  })

  it('★ legacy 会话不能续接', async () => {
    await expect(startAgentRun('x', { sessionId: 'lg_ar_abc' })).rejects.toThrow(/只读/)
  })

  it('★ startSession 返回 meta（标题取 goal）', async () => {
    const { run, meta } = await startSession('写个开头')
    expect(meta.id).toBe(run.sessionId)
    expect(meta.title).toBe('写个开头')
    stopAgentRun(run.id)
  })

  it('★ resumeSession 用快照重建上下文，并把作者这句话作为本轮输入', async () => {
    const first = await startAgentRun('写开头', { mode: 'new' })
    const before = lastAgent()
    before.state.messages.push({ role: 'user', content: '第一轮的话', timestamp: 1 })
    before.done()
    await vi.waitFor(async () => {
      expect((await readSessionMeta(h.root, first.sessionId))?.status).toBe('done')
    })
    const saved = await loadMessageSnapshot(h.root, first.sessionId)
    expect(saved?.messages.some((m) => JSON.stringify(m).includes('第一轮的话'))).toBe(true)

    // 模拟进程重启：内存里的 run 没了，只能从磁盘续接
    clearRuns()
    const resumed = await resumeSession(first.sessionId, '接着写第二段')
    const after = lastAgent()
    expect(
      after.opts.initialState.messages?.some((m) => JSON.stringify(m).includes('第一轮的话')),
    ).toBe(true)
    const events = getAgentRun(resumed.id)?.events ?? []
    expect(events.some((e) => e.type === 'user.message' && e.text === '接着写第二段')).toBe(true)
    // 作者的话必须真的进了 prompt，而不是被「继续做任务 X」盖过去
    expect(after.prompts.at(-1)).toContain('接着写第二段')
    stopAgentRun(resumed.id)
  })

  it('★ 等审批的会话在无 live run 时可以续接（重启后能救回来）', async () => {
    await writeSessionMeta(h.root, {
      id: 'cs_wait000000',
      title: '等审批',
      goal: 'g',
      status: 'waiting_review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tokens: 0,
      steps: 0,
      subagentCalls: 0,
      planId: null,
      planTitle: null,
      planDone: 0,
      planTotal: 0,
      runIds: [],
      resumable: false,
    })
    await saveMessageSnapshot(h.root, 'cs_wait000000', {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionId: 'cs_wait000000',
      runId: 'ar_old',
      messages: [{ role: 'user', content: '旧话', timestamp: 1 } as unknown as AgentMessage],
    })
    const resumed = await resumeSession('cs_wait000000', '继续')
    expect(resumed.sessionId).toBe('cs_wait000000')
    lastAgent().done()
    stopAgentRun(resumed.id)
  })

  it('★ 续接 run 一开跑就把 meta 置为 running（否则会被当成可删除）', async () => {
    const first = await startAgentRun('第一段', { mode: 'new' })
    lastAgent().done()
    await vi.waitFor(async () => {
      expect((await readSessionMeta(h.root, first.sessionId))?.status).toBe('done')
    })
    const second = await startAgentRun('第二段', {
      mode: 'resume',
      sessionId: first.sessionId,
      messages: [{ role: 'user', content: '继续', timestamp: 1 } as unknown as AgentMessage],
    })
    await vi.waitFor(async () => {
      expect((await readSessionMeta(h.root, first.sessionId))?.status).toBe('running')
    })
    lastAgent().done()
    stopAgentRun(second.id)
  })

  it('★ 同一会话两次运行会累积 runIds（旧 run 不覆盖新状态的前提）', async () => {
    const first = await startAgentRun('第一段', { mode: 'new' })
    lastAgent().done()
    await vi.waitFor(async () => {
      const meta = await readSessionMeta(h.root, first.sessionId)
      expect(meta?.status).toBe('done')
    })
    const second = await startAgentRun('第二段', { mode: 'new', sessionId: first.sessionId })
    lastAgent().done()
    await vi.waitFor(async () => {
      const meta = await readSessionMeta(h.root, first.sessionId)
      expect(meta?.runIds).toEqual([first.id, second.id])
    })
    stopAgentRun(second.id)
  })
})

describe('criticSkipReason', () => {
  const base = {
    id: 'sa_1',
    role: 'critic' as const,
    steps: 3,
    tokens: 100,
    text: '{"verdict":"passed"}',
  }

  it('★ partial 的 critic → 跳过并说明未跑完（不交给 JSON 解析器）', () => {
    const reason = criticSkipReason({
      ...base,
      ok: true,
      partial: true,
      error: '子任务步数上限（10 步）',
    })
    expect(reason).toBe('一致性检查未跑完（子任务步数上限（10 步））')
  })

  it('失败时用 error 当理由；无 error 时给兜底文案', () => {
    expect(criticSkipReason({ ...base, ok: false, partial: false, error: '连接超时' })).toBe(
      '连接超时',
    )
    expect(criticSkipReason({ ...base, ok: false, partial: false, error: null })).toBe(
      '子智能体失败',
    )
  })

  it('空文本单独说明，不报「不是合法 JSON」', () => {
    expect(criticSkipReason({ ...base, ok: true, partial: false, error: null, text: '   ' })).toBe(
      '子智能体没有给出检查结论',
    )
  })

  it('完整结论 → 不跳过（返回 null）', () => {
    expect(criticSkipReason({ ...base, ok: true, partial: false, error: null })).toBeNull()
  })
})
