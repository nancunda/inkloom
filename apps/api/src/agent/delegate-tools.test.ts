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
    partial: false,
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
async function startDoingTask(skill: 'world' | 'review' | 'free' = 'world'): Promise<void> {
  const written = await tool('write_plan').execute('c1', {
    title: '开篇计划',
    goal: '把骨架搭起来',
    tasks: [{ id: 'world', title: '世界', skill, brief: '写规则', review: 'none' }],
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
  // critic 开启时 done 必须列产物：先准备一个真实文件
  await mkdir(join(root, 'world'), { recursive: true })
  await writeFile(join(root, 'world', 'note.md'), '规则', 'utf8')
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
    // ★ task 里必须带上步数预算（子体不知道上限，会盲撞）
    expect(calls[0]?.task).toContain('查唐代驿站制度')
    expect(calls[0]?.task).toContain('最多 12 步')
    expect(calls[0]?.['context']).toBe('这本书是唐风玄幻')
  })

  it('★ 子体 partial → 返回成功文案但明确标注「未跑完」，结论保留', async () => {
    subagentImpl = async (req) => ({
      id: 'sa_partial',
      role: req.role,
      ok: true,
      partial: true,
      steps: 12,
      tokens: 900,
      text: '查到三条，第四条未核实',
      error: '子任务步数上限（12 步）',
    })
    const r = await tool('delegate').execute('c1', {
      role: 'researcher',
      task: '查驿站',
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('未跑完')
    expect(textOf(r)).toContain('子任务步数上限（12 步）')
    expect(textOf(r)).toContain('查到三条')
  })

  it('★ 子体失败时返回 fail，并带上已产出的部分结论', async () => {
    subagentImpl = async (req) => ({
      id: 'sa_test',
      role: req.role,
      ok: false,
      partial: false,
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
    const before = await readPlanState(root, planId as string)
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
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/note.md'],
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('一致性检查发现 1 处矛盾')
    expect(textOf(r)).toContain('characters/index.json#c1')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('doing')
    // 不只是状态没变：整份 state 不能被重写（updatedAt 完全相同）
    expect(state?.updatedAt).toBe(before?.updatedAt)
  })

  it('★ critic 故障 → 写 done，但明确标注未完成', async () => {
    await startDoingTask()
    tools = buildTools(async () => ({ kind: 'skipped', reason: '返回内容不是合法 JSON' }))
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/note.md'],
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('一致性检查未完成：返回内容不是合法 JSON')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('done')
  })

  it('★ critic 抛异常 → 按未完成放行，不让任务永久卡在 doing', async () => {
    await startDoingTask()
    tools = buildTools(async () => {
      throw new Error('fetch failed')
    })
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/note.md'],
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('一致性检查未完成：检查器出错（fetch failed）')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('done')
  })

  it('★ critic 开启时 done 必须列产物（否则可绕过检查）', async () => {
    await startDoingTask()
    tools = buildTools(async () => ({ kind: 'passed', warnings: [], suggestions: [] }))
    const r = await tool('update_task').execute('c1', { taskId: 'world', status: 'done' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('artifacts')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('doing')
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
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/note.md'],
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('一致性检查通过（1 处提示')
    expect(textOf(r)).toContain('统一用「掌门」')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('done')
  })

  it('★ review 任务不产文件：note 就是可核对的结论，可以完成', async () => {
    await startDoingTask('review')
    // 用对象属性而不是局部变量：TS 不会把回调里的赋值当窄化来源
    const seen: { input: CriticInput | null } = { input: null }
    tools = buildTools(async (input) => {
      seen.input = input
      return { kind: 'passed', warnings: [], suggestions: [] }
    })
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      note: '通读第 3 章：节奏前松后紧，建议砍掉第二场',
    })
    expect(r.isError).toBeFalsy()
    expect(seen.input?.artifacts).toEqual([])
    expect(seen.input?.summary).toContain('通读第 3 章')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('done')
  })

  it('★ review 任务既不产文件也不写 note → 仍然拦住（没有可核对的结论）', async () => {
    await startDoingTask('review')
    tools = buildTools(async () => ({ kind: 'passed', warnings: [], suggestions: [] }))
    const r = await tool('update_task').execute('c1', { taskId: 'world', status: 'done' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('note')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('doing')
  })

  it('★ 运行已停止（signal aborted）→ 不跑 critic、不写状态', async () => {
    await startDoingTask()
    const before = await readPlanState(root, planId as string)
    let called = 0
    tools = buildTools(async () => {
      called += 1
      return { kind: 'passed', warnings: [], suggestions: [] }
    })
    const ac = new AbortController()
    ac.abort()
    const r = await tool('update_task').execute(
      'c1',
      { taskId: 'world', status: 'done', artifacts: ['world/note.md'] },
      ac.signal,
    )
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('运行已停止')
    expect(called).toBe(0)
    const after = await readPlanState(root, planId as string)
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it('★ free 任务常常是写要素：空 artifacts 仍然拦住（不能靠一句 note 绕过）', async () => {
    await startDoingTask('free')
    tools = buildTools(async () => ({ kind: 'passed', warnings: [], suggestions: [] }))
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      note: '把驿传规则补进去了',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('artifacts')
    // 必须给出出口，否则只读任务会永久卡在 doing
    expect(textOf(r)).toContain('review')
    const state = await readPlanState(root, planId as string)
    expect(state?.tasks.find((t) => t.id === 'world')?.status).toBe('doing')
  })

  it('★ review 任务错传 artifacts → 指出契约错误，不带着文件去检查', async () => {
    await startDoingTask('review')
    tools = buildTools(async () => ({ kind: 'passed', warnings: [], suggestions: [] }))
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world/note.md'],
      note: '结论',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('artifacts=[]')
  })

  it('★ critic 检查期间被停止 → 返回后不写 done（覆盖最长 120s 的窗口）', async () => {
    await startDoingTask()
    const before = await readPlanState(root, planId as string)
    const ac = new AbortController()
    tools = buildTools(async () => {
      // 模拟作者在 critic 跑的时候点了停止
      ac.abort()
      return { kind: 'passed', warnings: [], suggestions: [] }
    })
    const r = await tool('update_task').execute(
      'c1',
      { taskId: 'world', status: 'done', artifacts: ['world/note.md'] },
      ac.signal,
    )
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('运行已停止')
    const after = await readPlanState(root, planId as string)
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it('★ 产物填成目录 → 给可执行提示，不是裸 EISDIR', async () => {
    await startDoingTask()
    tools = buildTools(async () => ({ kind: 'passed', warnings: [], suggestions: [] }))
    const r = await tool('update_task').execute('c1', {
      taskId: 'world',
      status: 'done',
      artifacts: ['world'],
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('不是目录')
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
