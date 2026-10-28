import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initRepo } from '../git/runner.js'
import type { IndexDb } from '../index-db/client.js'
import { closeContext, setContext } from '../services/context.js'
import { readPlanState, writePlanState } from '../storage/plans.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import type { CriticInput, CriticVerdict } from './critic.js'
import type { SubagentRequest, SubagentResult } from './subagent.js'
import { createAgentTools, type RunBudget } from './tools.js'

let root: string
let indexDir: string
let db: IndexDb
let tools: AgentTool[]
let planId: string | null
let calls: SubagentRequest[]

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

let subagentImpl: (req: SubagentRequest) => Promise<SubagentResult>

/** 每次调用都走当前实现，便于单个用例替换失败行为 */
const subagent = (req: SubagentRequest): Promise<SubagentResult> => subagentImpl(req)

const okSubagent = async (req: SubagentRequest): Promise<SubagentResult> => {
  calls.push(req)
  return {
    id: 'sa_test',
    role: req.role,
    ok: true,
    steps: 2,
    tokens: 120,
    text: '找到 2 条资料',
    error: null,
  }
}

function buildTools(critic?: (input: CriticInput) => Promise<CriticVerdict>): AgentTool[] {
  return createAgentTools({
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
    onGate: () => undefined,
    getRunId: () => 'ar_test',
    subagent,
    ...(critic === undefined ? {} : { critic }),
  })
}

/** 提交并批准一份只含一个「无审阅」任务的计划，把任务推到 doing */
async function startDoingTask(): Promise<void> {
  const written = await tool('write_plan').execute('c1', {
    title: '开篇计划',
    goal: '把骨架搭起来',
    tasks: [{ id: 'world', title: '世界', skill: 'world', brief: '写规则', review: 'none' }],
  })
  expect(written.isError).toBeFalsy()
  const id = planId as string
  const state = await readPlanState(root, id)
  if (state === null) throw new Error('计划状态文件不存在')
  await writePlanState(root, id, {
    ...state,
    status: 'approved',
    updatedAt: new Date().toISOString(),
  })
  const doing = await tool('update_task').execute('c2', { taskId: 'world', status: 'doing' })
  expect(doing.isError).toBeFalsy()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-delegate-'))
  indexDir = await mkdtemp(join(tmpdir(), 'inkloom-delegate-db-'))
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
  calls = []
  subagentImpl = okSubagent
  budget.steps = 0
  budget.subagentCalls = 0
  tools = buildTools()
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

describe('delegate', () => {
  it('★ 没注入 subagent → fail，不假装派过活', async () => {
    tools = createAgentTools({
      apiKey: 'sk-test',
      imageApiKey: null,
      model: 'deepseek-flash',
      budget,
      plan: { getPlanId: () => planId, setPlanId: () => undefined, notify: () => undefined },
      onGate: () => undefined,
      getRunId: () => 'ar_test',
    })
    const r = await tool('delegate').execute('c1', { role: 'researcher', task: '查驿站' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('没有启用子智能体')
  })

  it('★ 注入后返回步数、token 与摘要，并把 context 原样带给子体', async () => {
    const r = await tool('delegate').execute('c1', {
      role: 'researcher',
      task: '查唐代驿站制度',
      context: '这本书是唐风玄幻',
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('用了 2 步')
    expect(textOf(r)).toContain('120 tokens')
    expect(textOf(r)).toContain('找到 2 条资料')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      role: 'researcher',
      task: '查唐代驿站制度',
      context: '这本书是唐风玄幻',
    })
  })

  it('★ 子体失败时返回 fail，并带上已产出的部分结论', async () => {
    subagentImpl = async (req) => ({
      id: 'sa_test',
      role: req.role,
      ok: false,
      steps: 1,
      tokens: 10,
      text: '查到一半',
      error: '子任务超时（120000ms）',
    })
    const r = await tool('delegate').execute('c1', { role: 'researcher', task: 'x' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('子任务失败：子任务超时（120000ms）')
    expect(textOf(r)).toContain('查到一半')
  })
})

describe('update_task(done) 的 critic 门禁', () => {
  it('★ critic 报 error → 任务保持 doing，不写 state', async () => {
    await startDoingTask()
    tools = buildTools(async () => ({
      kind: 'blocked',
      errors: [
        {
          severity: 'error',
          message: '第 3 章写到林岚已筑基，但角色卡仍是炼气',
          evidence: ['characters/index.json#c1'],
        },
      ],
      warnings: [],
    }))
    const r = await tool('update_task').execute('c1', { taskId: 'world', status: 'done' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('一致性检查发现 1 处矛盾')
    expect(textOf(r)).toContain('characters/index.json#c1')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('doing')
  })

  it('★ critic 故障 → 写 done，但明确标注未完成', async () => {
    await startDoingTask()
    tools = buildTools(async () => ({ kind: 'skipped', reason: '返回内容不是合法 JSON' }))
    const r = await tool('update_task').execute('c1', { taskId: 'world', status: 'done' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('一致性检查未完成：返回内容不是合法 JSON')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('done')
  })

  it('★ critic 只有 warning → 写 done 并提示条数', async () => {
    await startDoingTask()
    tools = buildTools(async () => ({
      kind: 'passed',
      warnings: [
        { severity: 'warning', message: '称谓不统一', evidence: ['characters/index.json'] },
      ],
      suggestions: ['统一用「掌门」'],
    }))
    const r = await tool('update_task').execute('c1', { taskId: 'world', status: 'done' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('一致性检查通过（1 处提示')
    expect(textOf(r)).toContain('统一用「掌门」')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('done')
  })
})

describe('read_element 读正文', () => {
  it('★ 章节 Markdown 原样返回，不再是「文件不存在」', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(join(root, 'chapters', 'ch-001.md'), '# 第 1 章\n\n林岚御剑而行。', 'utf8')
    const r = await tool('read_element').execute('c1', { path: 'chapters/ch-001.md' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('林岚御剑而行')
  })
})
