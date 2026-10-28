import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initRepo } from '../git/runner.js'
import type { IndexDb } from '../index-db/client.js'
import { closeContext, setContext } from '../services/context.js'
import { generateChapter } from '../services/generate-service.js'
import {
  loadPlan,
  readCurrentPlan,
  readPlanDef,
  readPlanState,
  writePlanState,
} from '../storage/plans.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { type AgentGate, createAgentTools, type RunBudget } from './tools.js'

vi.mock('../services/generate-service.js', () => ({
  generateChapter: vi.fn(async ({ chapterNo }: { chapterNo: number }) => ({
    runId: `run_${chapterNo}`,
    chapterNo,
    scenes: [],
    warnings: [],
  })),
}))

let root: string
let indexDir: string
let db: IndexDb
let tools: AgentTool[]
let planId: string | null
let gates: AgentGate[]
let planTasks: { id: string; title: string; skill: string; review?: string }[]

const budget: RunBudget = {
  steps: 0,
  maxSteps: 40,
  chapterCalls: 0,
  portraitCalls: 0,
  subagentCalls: 0,
}

function tool(name: string): AgentTool {
  const found = tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`找不到工具 ${name}`)
  return found
}

function textOf(result: { content: unknown[]; isError?: boolean }): string {
  return result.content.map((c) => (c as { text?: string }).text ?? '').join('\n')
}

async function submitPlan(): Promise<void> {
  const r = await tool('write_plan').execute('c-write', {
    title: '开篇计划',
    goal: '把骨架搭起来',
    tasks: planTasks,
  })
  expect(r.isError).toBeFalsy()
}

/** 模拟作者批准计划（reviewAgentRun 会做同样的事） */
async function approvePlan(): Promise<void> {
  const id = planId
  if (id === null) throw new Error('还没有计划')
  const state = await readPlanState(root, id)
  if (state === null) throw new Error('计划状态文件不存在')
  await writePlanState(root, id, {
    ...state,
    status: 'approved',
    updatedAt: new Date().toISOString(),
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-plan-tools-'))
  indexDir = await mkdtemp(join(tmpdir(), 'inkloom-plan-db-'))
  const created = await createProject({
    rootPath: root,
    name: '测试书',
    genre: '玄幻',
    totalChapters: 3,
  })
  await initRepo(root)
  db = await freshIndexDb(indexDir)
  await setContext({ root, db, project: created.project })

  planId = null
  gates = []
  planTasks = [
    { id: 'world', title: '世界', skill: 'world' },
    { id: 'chapter-1', title: '第 1 章', skill: 'chapter', review: 'none' },
  ]
  tools = createAgentTools({
    apiKey: 'sk-test',
    imageApiKey: null,
    model: 'deepseek-flash',
    budget,
    plan: {
      getPlanId: () => planId,
      setPlanId: (id) => {
        planId = id
      },
      notify: () => undefined,
    },
    onGate: (g) => gates.push(g),
    getRunId: () => 'ar_test',
  })
})

afterEach(async () => {
  await closeContext()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  )
  await rm(indexDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  )
})

describe('write_plan / 规划期写保护', () => {
  it('写计划落两份文件（定义进 git、状态进 .inkloom）并设 current', async () => {
    await submitPlan()
    expect(planId).not.toBeNull()

    const plan = await loadPlan(root, planId as string)
    expect(plan?.status).toBe('drafting')
    expect(plan?.tasks.map((t) => t.status)).toEqual(['todo', 'todo'])
    expect(await readCurrentPlan(root)).toBe(planId)

    const def = await readPlanDef(root, planId as string)
    expect(def?.title).toBe('开篇计划')
    await expect(readPlanDef(root, 'plan-does-not-exist')).resolves.toBeNull()
  })

  it('★ 计划未批准时 write_element 被拒绝', async () => {
    await submitPlan()
    const r = await tool('write_element').execute('c1', {
      path: 'characters/index.json',
      entityType: 'character',
      entityId: 'c1',
      payload: [{ id: 'c1', name: '林岚', role: 'protagonist' }],
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('作者批准前不能写')
  })

  it('request_review(kind=plan) 生成计划门禁并把状态推到 awaiting_approval', async () => {
    await submitPlan()
    const r = await tool('request_review').execute('c1', {
      kind: 'plan',
      summary: '请批准这份计划',
    })
    expect(r.isError).toBeFalsy()
    expect(r.terminate).toBe(true)
    expect(gates.at(-1)?.kind).toBe('plan')
    expect((await loadPlan(root, planId as string))?.status).toBe('awaiting_approval')
  })
})

describe('批准后的执行', () => {
  it('★ 批准后 write_element 可以落盘', async () => {
    await submitPlan()
    await approvePlan()

    const r = await tool('write_element').execute('c1', {
      path: 'characters/index.json',
      entityType: 'character',
      entityId: 'c1',
      payload: [{ id: 'c1', name: '林岚', role: 'protagonist' }],
    })
    expect(r.isError).toBeFalsy()
    expect(await db.character.count()).toBe(1)
  })

  it('update_task(done) 逐个校验产物存在', async () => {
    await submitPlan()
    await approvePlan()

    const bad = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/not-there.json'],
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('产物不存在')

    await mkdir(join(root, 'world'), { recursive: true })
    await writeFile(join(root, 'world/rules.json'), '[]\n', 'utf8')
    const good = await tool('update_task').execute('c2', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/rules.json'],
    })
    expect(good.isError).toBeFalsy()
    expect((await loadPlan(root, planId as string))?.tasks[0]?.status).toBe('done')
  })

  it('request_review(kind=task) 生成任务门禁', async () => {
    await submitPlan()
    await approvePlan()
    await mkdir(join(root, 'world'), { recursive: true })
    await writeFile(join(root, 'world/rules.json'), '[]\n', 'utf8')
    await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/rules.json'],
    })

    const r = await tool('request_review').execute('c2', {
      kind: 'task',
      taskId: 'world',
      summary: '世界写完了，请看看',
    })
    expect(r.isError).toBeFalsy()
    expect(gates.at(-1)).toMatchObject({ kind: 'task', taskId: 'world' })
  })

  it('update_plan 不能删掉已完成的任务', async () => {
    await submitPlan()
    await approvePlan()
    await mkdir(join(root, 'world'), { recursive: true })
    await writeFile(join(root, 'world/rules.json'), '[]\n', 'utf8')
    await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/rules.json'],
    })

    const r = await tool('update_plan').execute('c2', {
      title: '开篇计划',
      goal: '把骨架搭起来',
      tasks: [{ id: 'chapter-1', title: '第 1 章', skill: 'chapter', review: 'none' }],
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('不能删掉已完成的任务')
  })
})

describe('章节与形象图额度', () => {
  it('★ 一次会话可以连续生成 3 章，不再有硬上限', async () => {
    await submitPlan()
    await approvePlan()
    budget.chapterCalls = 0
    vi.mocked(generateChapter).mockClear()

    for (let n = 1; n <= 3; n += 1) {
      const r = await tool('generate_chapter').execute(`c-${n}`, { chapterNo: n })
      expect(r.isError).toBeFalsy()
    }
    expect(budget.chapterCalls).toBe(3)
    expect(vi.mocked(generateChapter)).toHaveBeenCalledTimes(3)
  })
})
