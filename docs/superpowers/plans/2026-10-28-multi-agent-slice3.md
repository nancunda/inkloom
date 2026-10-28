# 切片 3：多智能体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主 Agent 通过 `delegate` 派只读角色子智能体（researcher / worldbuilder / critic / stylist），并在每个任务 `done` 前由 critic 自动做一次一致性检查，`error` 级矛盾阻断 `done`。

**Architecture:** 角色与白名单在 `roles.ts`；`subagent.ts` 用独立 Pi `Agent` 实例跑同步子任务（共享主 `budget.steps`、自带 `maxSteps` 与 120s 超时），通过 `subagent.*` 事件把过程推给前端；`critic.ts` 用纯函数解析并裁决 critic 输出；`tools.ts` 只负责接线（`delegate` 工具 + `update_task(done)` 三态）。

**Tech Stack:** TypeScript 5（strict / exactOptionalPropertyTypes / noUncheckedIndexedAccess）、Pi Agent `1.4.0`（`@earendil-works/pi-agent-core` + `pi-ai`）、TypeBox `1.3.27`、Vitest 5、React 19 + Tailwind、Hono。

**Spec:** `docs/superpowers/specs/2026-10-28-multi-agent-slice3-design.md`

## Global Constraints

- **不新增任何 npm 依赖**：`apps/api` 只有 TypeBox；critic 输出用手写结构校验。
- **子智能体只读**：角色白名单永远不含 `delegate`、`write_element`、`write_blueprint`、`write_plan`、`update_plan`、`update_task`、`request_review`、`generate_chapter`、`generate_portrait`。
- **子体步数受双上限约束**：主 `budget.steps < budget.maxSteps` 且子体 `steps < role.maxSteps`；任一触顶返回 `{ block: true, terminate: true }`。
- **失败不抛**：`subagent` 运行器永远 resolve；`critic` 故障返回 `{ kind: 'skipped' }`。
- **可选属性必须条件展开**（`exactOptionalPropertyTypes`）：`...(x === undefined ? {} : { x })`。
- **格式**：2 空格缩进、单引号、无分号（Biome）；注释写「为什么」，不写「做了什么」。
- **单文件测试命令**：`pnpm vitest run --project unit apps/api/src/agent/<name>.test.ts`（在仓库根执行）。
- **提交信息**：英文 conventional commits（`feat(agent): ...`）。
- **事件类型两份同步**：`apps/api/src/agent/run-service.ts` 的 `AgentStreamPayload` 与 `apps/web/src/api/types.ts` 的 `AgentEvent`。

---

## File Structure

新增：

| 文件 | 职责 |
|---|---|
| `apps/api/src/agent/roles.ts` | 四角色定义、白名单、`toolsForRole()` |
| `apps/api/src/agent/roles.test.ts` | 白名单不含写工具 / 不含 `delegate` |
| `apps/api/src/agent/subagent.ts` | 子体运行器（独立 Agent、双步数上限、超时、事件） |
| `apps/api/src/agent/subagent.test.ts` | mock Pi Agent 验证步数、事件、失败语义 |
| `apps/api/src/agent/critic.ts` | critic 输出解析 + 裁决（纯函数） |
| `apps/api/src/agent/critic.test.ts` | 围栏/坏 JSON/evidence 过滤/裁决 |

修改：

| 文件 | 改动 |
|---|---|
| `apps/api/src/agent/tools.ts` | `RunBudget.subagentCalls`、`AgentToolDeps.subagent/critic`、`delegate` 工具、`update_task(done)` 三态 |
| `apps/api/src/agent/tools.test.ts` | delegate 与 critic 接线用例 |
| `apps/api/src/agent/run-service.ts` | runner 组装、critic 注入、`subagent.*` 事件、子体 token 累加、budget 初始化 |
| `apps/api/src/agent/run-service.test.ts` | 事件转发、critic 关闭时不注入 |
| `apps/api/src/routes/settings.ts` | `INKLOOM_CRITIC` 白名单/默认/校验 |
| `apps/web/src/api/types.ts` | `AgentRoleId`、三个事件、`subagentCalls` |
| `apps/web/src/pages/AgentPage.tsx` | 子智能体 Block + 卡片 + 预算行 |
| `apps/web/src/pages/SettingsPage.tsx` | 「任务后一致性检查」开关 |

---

### Task 1: 角色定义与白名单

**Files:**
- Create: `apps/api/src/agent/roles.ts`
- Test: `apps/api/src/agent/roles.test.ts`

**Interfaces:**
- Consumes: `AgentTool`（`@earendil-works/pi-agent-core`）
- Produces:
  - `type AgentRoleId = 'researcher' | 'worldbuilder' | 'critic' | 'stylist'`
  - `interface AgentRole { id; label; systemPrompt; tools: readonly string[]; maxSteps; output: 'text' | 'json' }`
  - `AGENT_ROLES: Record<AgentRoleId, AgentRole>`
  - `AGENT_ROLE_IDS: readonly AgentRoleId[]`
  - `isAgentRoleId(v: string): v is AgentRoleId`
  - `toolsForRole(role: AgentRole, all: readonly AgentTool[]): AgentTool[]`

- [ ] **Step 1: 写失败的测试**

创建 `apps/api/src/agent/roles.test.ts`：

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import { AGENT_ROLES, AGENT_ROLE_IDS, isAgentRoleId, toolsForRole } from './roles.js'

const FORBIDDEN = [
  'delegate',
  'write_element',
  'write_blueprint',
  'write_plan',
  'update_plan',
  'update_task',
  'request_review',
  'generate_chapter',
  'generate_portrait',
]

function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  } as unknown as AgentTool
}

describe('AGENT_ROLES', () => {
  it('★ 四个角色齐全，id 与键一致', () => {
    expect(AGENT_ROLE_IDS).toEqual(['researcher', 'worldbuilder', 'critic', 'stylist'])
    for (const id of AGENT_ROLE_IDS) {
      expect(AGENT_ROLES[id].id).toBe(id)
      expect(AGENT_ROLES[id].systemPrompt.length).toBeGreaterThan(40)
    }
  })

  it('★ 白名单永远不含写工具与 delegate', () => {
    for (const role of Object.values(AGENT_ROLES)) {
      for (const banned of FORBIDDEN) expect(role.tools).not.toContain(banned)
      expect(role.maxSteps).toBeGreaterThanOrEqual(4)
      expect(role.maxSteps).toBeLessThanOrEqual(6)
    }
    expect(AGENT_ROLES.critic.output).toBe('json')
    expect(AGENT_ROLES.researcher.output).toBe('text')
  })

  it('isAgentRoleId 只认四个角色', () => {
    expect(isAgentRoleId('critic')).toBe(true)
    expect(isAgentRoleId('writer')).toBe(false)
  })

  it('toolsForRole 只放行白名单内、且真实存在的工具', () => {
    const all = [
      fakeTool('web_search'),
      fakeTool('read_book'),
      fakeTool('write_element'),
      fakeTool('delegate'),
      fakeTool('不存在的工具'),
    ]
    const got = toolsForRole(AGENT_ROLES.researcher, all).map((t) => t.name)
    expect(got).toEqual(['web_search', 'read_book'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/roles.test.ts`
Expected: FAIL — `Cannot find module './roles.js'`

- [ ] **Step 3: 实现 roles.ts**

创建 `apps/api/src/agent/roles.ts`：

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'

export type AgentRoleId = 'researcher' | 'worldbuilder' | 'critic' | 'stylist'

export interface AgentRole {
  id: AgentRoleId
  label: string
  systemPrompt: string
  /** 工具白名单：只允许只读工具；永远不含 delegate 与写工具 */
  tools: readonly string[]
  maxSteps: number
  output: 'text' | 'json'
}

/**
 * 四个角色共用的边界：没有写权限。
 * ★ 这段话是防线的一部分，不是客套：子体的工具集已经被白名单裁过，
 *   但模型仍可能「建议自己调用写工具」，必须明确禁止。
 */
const READ_ONLY =
  '你没有写权限：不能改文件、不能提交计划、不能请求审阅、不能派活给其他智能体。只用工具返回的事实，不要编造文件内容。结论要能被作者直接使用。'

export const AGENT_ROLES: Record<AgentRoleId, AgentRole> = {
  researcher: {
    id: 'researcher',
    label: '研究员',
    systemPrompt: [
      '你是这本书的考据研究员。任务是用联网搜索与阅读，为主 Agent 提供可核验的外部资料。',
      READ_ONLY,
      '每条结论都必须附来源 URL 或资料卡 id；搜不到就直说搜不到，不要用常识补。',
      '一次只查一个问题：先 web_search，需要细节再 read_url；read_book 只用来确认书内已有设定，不要整篇复述。',
    ].join('\n'),
    tools: ['web_search', 'read_url', 'read_lore', 'read_book'],
    maxSteps: 6,
    output: 'text',
  },
  worldbuilder: {
    id: 'worldbuilder',
    label: '世界建筑师',
    systemPrompt: [
      '你是这本书的世界观建筑师。任务是读现有设定与图谱，指出该补哪些节点、边、规则，并说明为什么。',
      READ_ONLY,
      '建议必须落到具体 id / type / 是否已存在；优先复用已有节点，不要造重复概念。',
      '用 query_graph / find_path 核对现状，不要凭印象说「还没有」。',
    ].join('\n'),
    tools: ['read_book', 'read_element', 'query_graph', 'find_path'],
    maxSteps: 5,
    output: 'text',
  },
  critic: {
    id: 'critic',
    label: '一致性检查员',
    systemPrompt: [
      '你是这本书的一致性检查员。任务是核对「本次产物」与既有设定、图谱、章节状态是否矛盾。',
      READ_ONLY,
      '只报矛盾，不报审美偏好：人物/地点/规则/时间线/境界/称谓前后不符才算矛盾。',
      '每条矛盾必须给 evidence（文件相对路径或节点 id）；给不出 evidence 的不要写。',
      '没有矛盾就返回空数组。',
      '只输出 JSON，不要任何解释文字，格式：',
      '{"conflicts":[{"severity":"error","message":"…","evidence":["characters/index.json"]}],"suggestions":["…"]}',
      'severity 用 error 表示「必须修」，warning 表示「建议修」。',
    ].join('\n'),
    tools: ['read_book', 'read_element', 'query_graph', 'find_path', 'explain_fact'],
    maxSteps: 5,
    output: 'json',
  },
  stylist: {
    id: 'stylist',
    label: '文风顾问',
    systemPrompt: [
      '你是这本书的文风顾问。任务是读正文与文风设定，给出可执行的局部修改建议。',
      READ_ONLY,
      '只给建议不重写：指出哪一句、改成什么、为什么，最多 8 条。',
      '关注视角、句长、对话贴合人物、AI 味套话；不评价剧情好不好。',
    ].join('\n'),
    tools: ['read_book', 'read_element'],
    maxSteps: 4,
    output: 'text',
  },
}

export const AGENT_ROLE_IDS: readonly AgentRoleId[] = [
  'researcher',
  'worldbuilder',
  'critic',
  'stylist',
]

export function isAgentRoleId(v: string): v is AgentRoleId {
  return (AGENT_ROLE_IDS as readonly string[]).includes(v)
}

/**
 * 按白名单过滤工具全集。
 * ★ 白名单里写了但当前会话没有的工具（例如未配置搜索）直接跳过，
 *   不报错：角色仍可退化成只读模式工作。
 */
export function toolsForRole(role: AgentRole, all: readonly AgentTool[]): AgentTool[] {
  const allowed = new Set(role.tools)
  return all.filter((t) => allowed.has(t.name))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project unit apps/api/src/agent/roles.test.ts`
Expected: PASS — 4 passed

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/agent/roles.ts apps/api/src/agent/roles.test.ts
git commit -m "feat(agent): add read-only subagent role definitions"
```

---

### Task 2: 子智能体运行器

**Files:**
- Create: `apps/api/src/agent/subagent.ts`
- Test: `apps/api/src/agent/subagent.test.ts`

**Interfaces:**
- Consumes: `Agent` / `AgentEvent` / `AgentTool` / `StreamFn`（pi-agent-core）、`Model`（pi-ai）、`AGENT_ROLES` / `AgentRoleId` / `toolsForRole`（Task 1）、`clip`（`./tool-result.js`）
- Produces:
  - `interface SubagentRequest { role; task; context? }`
  - `interface SubagentResult { id; role; ok; steps; tokens; text; error }`
  - `type SubagentEvent`（`started` / `tool` / `ended`，`ended` 带 `summary`）
  - `createSubagentRunner(deps: SubagentRunnerDeps): (req) => Promise<SubagentResult>`
  - `deps` 形状：`{ model; streamFn; getTools; budget; onEvent; onTokens; timeoutMs? }`

- [ ] **Step 1: 写失败的测试**

创建 `apps/api/src/agent/subagent.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubagentRunner, type SubagentEvent } from './subagent.js'

interface FakeAgentLike {
  opts: {
    initialState: { systemPrompt: string; tools: { name: string }[] }
    beforeToolCall?: () => Promise<{ block?: boolean; terminate?: boolean; reason?: string } | undefined>
  }
  state: { errorMessage?: string }
  listeners: ((e: unknown) => void)[]
  prompts: string[]
}

const h = vi.hoisted(() => ({
  agents: [] as unknown[],
  script: [] as unknown[],
  throwOnPrompt: null as Error | null,
}))

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgent {
    opts: unknown
    state: { errorMessage?: string } = {}
    listeners: ((e: unknown) => void)[] = []
    prompts: string[] = []

    constructor(opts: unknown) {
      this.opts = opts
      ;(h.agents as unknown[]).push(this)
    }

    subscribe(cb: (e: unknown) => void): () => void {
      this.listeners.push(cb)
      return () => {
        this.listeners = this.listeners.filter((l) => l !== cb)
      }
    }

    async prompt(text: string): Promise<void> {
      this.prompts.push(text)
      if (h.throwOnPrompt !== null) throw h.throwOnPrompt
      for (const e of h.script) for (const l of this.listeners) l(e)
    }

    abort(): void {}
  }
  return { Agent: FakeAgent }
})

const tool = (name: string) => ({ name, label: name, description: name }) as never

function deps() {
  const budget = { steps: 0, maxSteps: 80, subagentCalls: 0 }
  const events: SubagentEvent[] = []
  let tokens = 0
  const run = createSubagentRunner({
    model: {} as never,
    streamFn: (() => undefined) as never,
    getTools: () => [tool('web_search'), tool('write_element'), tool('delegate')],
    budget,
    onEvent: (e) => events.push(e),
    onTokens: (n) => {
      tokens += n
    },
    timeoutMs: 50,
  })
  return { run, budget, events, tokens: () => tokens }
}

describe('createSubagentRunner', () => {
  beforeEach(() => {
    h.agents.length = 0
    h.script = []
    h.throwOnPrompt = null
  })

  it('★ 正常结束：取最后一条文本、累加 token、发 started→tool→ended', async () => {
    h.script = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '先查搜索' }] },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '找到 2 条资料' }],
          usage: { input: 100, output: 40 },
        },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'web_search',
        isError: false,
        result: { content: [{ text: '2 条结果' }] },
      },
    ]
    const d = deps()
    const r = await d.run({ role: 'researcher', task: '查唐代驿站' })

    expect(r.ok).toBe(true)
    expect(r.text).toBe('找到 2 条资料')
    expect(r.tokens).toBe(140)
    expect(d.tokens()).toBe(140)
    expect(d.budget.subagentCalls).toBe(1)
    expect(d.events.map((e) => e.type)).toEqual(['started', 'tool', 'ended'])
    expect(new Set(d.events.map((e) => e.id)).size).toBe(1)
    const ended = d.events[2] as Extract<SubagentEvent, { type: 'ended' }>
    expect(ended.summary).toBe('找到 2 条资料')
  })

  it('★ 子体工具集被白名单裁剪：没有 write_element / delegate', async () => {
    const d = deps()
    await d.run({ role: 'researcher', task: 'x' })
    const agent = (h.agents[0] as unknown as { opts: { initialState: { tools: { name: string }[] } } })
    expect(agent.opts.initialState.tools.map((t) => t.name)).toEqual(['web_search'])
  })

  it('★ 子体步数触顶 → block + terminate，主步数同步累加', async () => {
    const d = deps()
    await d.run({ role: 'stylist', task: 'x' })
    const agent = (h.agents[0] as unknown as FakeAgentLike)
    const call = () => agent.opts.beforeToolCall?.()
    for (let i = 0; i < 4; i += 1) expect(await call()).toBeUndefined()
    const blocked = await call()
    expect(blocked).toMatchObject({ block: true, terminate: true })
    expect(d.budget.steps).toBe(4)
  })

  it('★ 主预算用尽 → 第一个工具调用就被挡', async () => {
    const d = deps()
    d.budget.steps = 80
    await d.run({ role: 'researcher', task: 'x' })
    const agent = (h.agents[0] as unknown as FakeAgentLike)
    expect(await agent.opts.beforeToolCall?.()).toMatchObject({
      block: true,
      terminate: true,
      reason: expect.stringContaining('步数预算已用尽'),
    })
  })

  it('★ prompt 抛错 → ok=false 且不向调用方抛', async () => {
    h.throwOnPrompt = new Error('模型调用失败')
    const d = deps()
    const r = await d.run({ role: 'critic', task: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('模型调用失败')
    expect(d.events.map((e) => e.type)).toEqual(['started', 'ended'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/subagent.test.ts`
Expected: FAIL — `Cannot find module './subagent.js'`

- [ ] **Step 3: 实现 subagent.ts**

创建 `apps/api/src/agent/subagent.ts`：

```ts
import { randomUUID } from 'node:crypto'
import {
  Agent,
  type AgentEvent,
  type AgentInitialState,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import { AGENT_ROLES, type AgentRoleId, toolsForRole } from './roles.js'
import { clip } from './tool-result.js'

export interface SubagentRequest {
  role: AgentRoleId
  task: string
  context?: string
}

export interface SubagentResult {
  id: string
  role: AgentRoleId
  /** false = 超时、抛错、步数超限；text 仍可能是已产出的部分结论 */
  ok: boolean
  steps: number
  tokens: number
  text: string
  error: string | null
}

export type SubagentEvent =
  | { type: 'started'; id: string; role: AgentRoleId; task: string }
  | { type: 'tool'; id: string; role: AgentRoleId; toolName: string; ok: boolean; summary: string }
  | {
      type: 'ended'
      id: string
      role: AgentRoleId
      ok: boolean
      steps: number
      tokens: number
      /** 结果文本前 400 字，前端卡片直接展示 */
      summary: string
    }

export interface SubagentRunnerDeps {
  /** Pi 模型对象：取自 AgentInitialState，避免手写 Model<any>（Biome 禁 explicit any） */
  model: NonNullable<AgentInitialState['model']>
  streamFn: StreamFn
  /** 惰性取工具全集：runner 在 delegate 执行期才取，避免与 createAgentTools 循环依赖 */
  getTools: () => readonly AgentTool[]
  budget: { steps: number; maxSteps: number; subagentCalls: number }
  onEvent: (e: SubagentEvent) => void
  onTokens: (n: number) => void
  timeoutMs?: number
}

const MAX_TEXT = 6000
const DEFAULT_TIMEOUT_MS = 120_000

function taskMessage(req: SubagentRequest): string {
  const lines = [`# 任务`, req.task.trim()]
  if (req.context !== undefined && req.context.trim().length > 0) {
    lines.push('', '# 背景', req.context.trim())
  }
  return lines.join('\n')
}

function assistantText(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const p = part as { type?: string; text?: string }
    if (p.type === 'text' && typeof p.text === 'string') text += p.text
  }
  return text.trim()
}

export function createSubagentRunner(
  deps: SubagentRunnerDeps,
): (req: SubagentRequest) => Promise<SubagentResult> {
  return async function runSubagent(req: SubagentRequest): Promise<SubagentResult> {
    const role = AGENT_ROLES[req.role]
    const id = `sa_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    deps.budget.subagentCalls += 1
    deps.onEvent({ type: 'started', id, role: role.id, task: req.task })

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let steps = 0
    let tokens = 0
    let text = ''
    let error: string | null = null
    let timedOut = false

    const agent = new Agent({
      initialState: {
        systemPrompt: role.systemPrompt,
        model: deps.model,
        thinkingLevel: 'low',
        tools: toolsForRole(role, deps.getTools()),
      },
      streamFn: deps.streamFn,
      toolExecution: 'sequential',
      beforeToolCall: async () => {
        // ★ 双上限：主预算保护整场会话，角色上限保护单次子任务
        if (deps.budget.steps >= deps.budget.maxSteps) {
          return {
            block: true,
            terminate: true,
            reason: `主会话步数预算已用尽（${deps.budget.maxSteps} 步）`,
          }
        }
        if (steps >= role.maxSteps) {
          return {
            block: true,
            terminate: true,
            reason: `子任务步数上限（${role.maxSteps} 步）`,
          }
        }
        deps.budget.steps += 1
        steps += 1
        return undefined
      },
    })

    const unsubscribe = agent.subscribe((e: AgentEvent) => {
      if (timedOut) return
      if (e.type === 'message_end') {
        const msg = e.message as { role?: string; usage?: { input?: number; output?: number } }
        if (msg.role !== 'assistant') return
        const t = assistantText(e.message)
        if (t.length > 0) text = t
        const usage = msg.usage
        if (usage !== undefined) {
          const n = (usage.input ?? 0) + (usage.output ?? 0)
          if (n > 0) {
            tokens += n
            deps.onTokens(n)
          }
        }
        return
      }
      if (e.type === 'tool_execution_end') {
        const result = e.result as { content?: { text?: string }[] }
        const raw = (result.content ?? [])
          .map((c) => c.text ?? '')
          .join('\n')
          .trim()
        deps.onEvent({
          type: 'tool',
          id,
          role: role.id,
          toolName: e.toolName,
          ok: e.isError !== true,
          summary: clip(raw.length === 0 ? '(无输出)' : raw),
        })
      }
    })

    const timer = setTimeout(() => {
      timedOut = true
      agent.abort()
    }, timeoutMs)

    try {
      await agent.prompt(taskMessage(req))
    } catch (e) {
      // 超时也会走到这里（abort），交给下面的 timedOut 分支统一处理
      if (!timedOut) error = (e as Error).message
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }

    if (timedOut) {
      error = `子任务超时（${timeoutMs}ms）`
    } else if (error === null) {
      const stateError = agent.state.errorMessage
      if (typeof stateError === 'string' && stateError.length > 0) error = stateError
    }

    const trimmed =
      text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…（共 ${text.length} 字符）`
    const ok = error === null
    deps.onEvent({
      type: 'ended',
      id,
      role: role.id,
      ok,
      steps,
      tokens,
      summary: trimmed.slice(0, 400),
    })
    return { id, role: role.id, ok, steps, tokens, text: trimmed, error }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project unit apps/api/src/agent/subagent.test.ts`
Expected: PASS — 5 passed

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/agent/subagent.ts apps/api/src/agent/subagent.test.ts
git commit -m "feat(agent): add bounded subagent runner"
```

---

### Task 3: critic 输出解析与裁决

**Files:**
- Create: `apps/api/src/agent/critic.ts`
- Test: `apps/api/src/agent/critic.test.ts`

**Interfaces:**
- Produces:
  - `interface CriticConflict { severity: 'error' | 'warning'; message: string; evidence: string[] }`
  - `interface CriticReport { conflicts: CriticConflict[]; suggestions: string[] }`
  - `interface CriticInput { taskId; title; brief; artifacts: string[]; summary: string | null; goal }`
  - `type CriticVerdict = { kind:'passed'; warnings; suggestions } | { kind:'blocked'; errors; warnings } | { kind:'skipped'; reason }`
  - `parseCriticReport(text: string): CriticReport | null`
  - `decideCritic(report: CriticReport | null): CriticVerdict`

- [ ] **Step 1: 写失败的测试**

创建 `apps/api/src/agent/critic.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { decideCritic, parseCriticReport } from './critic.js'

describe('parseCriticReport', () => {
  it('★ 纯 JSON 与 ```json 围栏都能解析', () => {
    const body = JSON.stringify({
      conflicts: [
        {
          severity: 'error',
          message: '第 3 章已筑基，角色卡仍是炼气',
          evidence: ['characters/index.json#c1'],
        },
      ],
      suggestions: ['补一条 events 记录'],
    })
    for (const text of [body, `\`\`\`json\n${body}\n\`\`\``]) {
      const r = parseCriticReport(text)
      expect(r?.conflicts).toHaveLength(1)
      expect(r?.suggestions).toEqual(['补一条 events 记录'])
    }
  })

  it('★ 坏 JSON / 结构不对 → null', () => {
    expect(parseCriticReport('不是 JSON')).toBeNull()
    expect(parseCriticReport('{"conflicts":"nope"}')).toBeNull()
    expect(parseCriticReport('[]')).toBeNull()
  })

  it('★ 没有 evidence 的矛盾被丢弃（没证据不采信）', () => {
    const r = parseCriticReport(
      JSON.stringify({
        conflicts: [
          { severity: 'error', message: '没有证据', evidence: [] },
          { severity: 'warning', message: '有证据', evidence: ['world/rules.json'] },
        ],
      }),
    )
    expect(r?.conflicts.map((c) => c.message)).toEqual(['有证据'])
    expect(r?.suggestions).toEqual([])
  })
})

describe('decideCritic', () => {
  it('★ 只有 error 阻断；warning 放行', () => {
    const warning = {
      conflicts: [{ severity: 'warning' as const, message: '称谓不统一', evidence: ['a.json'] }],
      suggestions: [],
    }
    expect(decideCritic(warning).kind).toBe('passed')

    const error = {
      conflicts: [
        { severity: 'error' as const, message: '境界矛盾', evidence: ['b.json'] },
        ...warning.conflicts,
      ],
      suggestions: ['改角色卡'],
    }
    const v = decideCritic(error)
    expect(v.kind).toBe('blocked')
    if (v.kind !== 'blocked') return
    expect(v.errors).toHaveLength(1)
    expect(v.warnings).toHaveLength(1)
  })

  it('★ null → skipped（故障按未完成处理）', () => {
    expect(decideCritic(null)).toEqual({ kind: 'skipped', reason: '返回内容不是合法 JSON' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/critic.test.ts`
Expected: FAIL — `Cannot find module './critic.js'`

- [ ] **Step 3: 实现 critic.ts**

创建 `apps/api/src/agent/critic.ts`：

```ts
export interface CriticConflict {
  severity: 'error' | 'warning'
  message: string
  evidence: string[]
}

export interface CriticReport {
  conflicts: CriticConflict[]
  suggestions: string[]
}

export interface CriticInput {
  taskId: string
  title: string
  brief: string
  artifacts: string[]
  summary: string | null
  goal: string
}

export type CriticVerdict =
  | { kind: 'passed'; warnings: CriticConflict[]; suggestions: string[] }
  | { kind: 'blocked'; errors: CriticConflict[]; warnings: CriticConflict[] }
  | { kind: 'skipped'; reason: string }

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stripFence(text: string): string {
  const t = text.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  return m === null ? t : (m[1] ?? '').trim()
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
}

/**
 * 解析 critic 的 JSON 输出。
 * ★ 手写校验而不是 zod：apps/api 只依赖 typebox，为一个解析器引入整套 schema 库不划算；
 *   结构不对就返回 null（调用方按「检查未完成」放行），绝不做猜测性修补。
 */
export function parseCriticReport(text: string): CriticReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    return null
  }
  if (!isRec(parsed)) return null
  const rawConflicts = parsed['conflicts']
  if (!Array.isArray(rawConflicts)) return null
  const rawSuggestions = parsed['suggestions']
  if (rawSuggestions !== undefined && !Array.isArray(rawSuggestions)) return null

  const conflicts: CriticConflict[] = []
  for (const item of rawConflicts) {
    if (!isRec(item)) continue
    const severity = item['severity']
    const message = item['message']
    if (severity !== 'error' && severity !== 'warning') continue
    if (typeof message !== 'string' || message.trim().length === 0) continue
    const evidence = strings(item['evidence'])
    // ★ 没有证据的矛盾不采信：模型很容易编一条「看起来有道理」的冲突
    if (evidence.length === 0) continue
    conflicts.push({ severity, message: message.trim(), evidence })
  }
  return { conflicts, suggestions: strings(rawSuggestions) }
}

export function decideCritic(report: CriticReport | null): CriticVerdict {
  if (report === null) return { kind: 'skipped', reason: '返回内容不是合法 JSON' }
  const errors = report.conflicts.filter((c) => c.severity === 'error')
  const warnings = report.conflicts.filter((c) => c.severity === 'warning')
  if (errors.length > 0) return { kind: 'blocked', errors, warnings }
  return { kind: 'passed', warnings, suggestions: report.suggestions }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project unit apps/api/src/agent/critic.test.ts`
Expected: PASS — 5 passed

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/agent/critic.ts apps/api/src/agent/critic.test.ts
git commit -m "feat(agent): parse and judge critic reports"
```

---

### Task 4: `delegate` 工具与 `update_task` 三态

**Files:**
- Modify: `apps/api/src/agent/tools.ts`（`RunBudget` / `AgentToolDeps` / 新增 `DELEGATE` 与 `delegateTool` / `updateTaskTool` 的 done 分支 / return 数组）
- Modify: `apps/api/src/agent/plan-tools.test.ts:38-43`（`RunBudget` 字面量补 `subagentCalls`）
- Test: `apps/api/src/agent/delegate-tools.test.ts`（新建）

**Interfaces:**
- Consumes: `isAgentRoleId`（Task 1）、`SubagentRequest` / `SubagentResult`（Task 2）、`CriticInput` / `CriticVerdict`（Task 3）
- Produces:
  - `RunBudget` 增加 `subagentCalls: number`
  - `AgentToolDeps` 增加 `subagent?: (req: SubagentRequest) => Promise<SubagentResult>`、`critic?: (input: CriticInput) => Promise<CriticVerdict>`
  - 工具 `delegate`（参数 `{ role, task, context? }`）
  - `update_task(status='done')` 在 `critic` 注入时按 `blocked | passed | skipped` 三态处理

- [ ] **Step 1: 写失败的测试**

创建 `apps/api/src/agent/delegate-tools.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
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
  return { id: 'sa_test', role: req.role, ok: true, steps: 2, tokens: 120, text: '找到 2 条资料', error: null }
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
  await writePlanState(root, id, { ...state, status: 'approved', updatedAt: new Date().toISOString() })
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
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  await rm(indexDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
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
    expect(textOf(r)).toContain('2,120 tokens')
    expect(textOf(r)).toContain('找到 2 条资料')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ role: 'researcher', task: '查唐代驿站制度', context: '这本书是唐风玄幻' })
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
      warnings: [{ severity: 'warning', message: '称谓不统一', evidence: ['characters/index.json'] }],
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/delegate-tools.test.ts`
Expected: FAIL — `delegate` 工具不存在（`找不到工具 delegate`）

- [ ] **Step 3: 改 `RunBudget` 与 `AgentToolDeps`**

在 `apps/api/src/agent/tools.ts` 中：

```ts
export interface RunBudget {
  steps: number
  maxSteps: number
  /** 只统计；不再拦截（作者可以连续写多章） */
  chapterCalls: number
  /** 只统计；不再拦截 */
  portraitCalls: number
  /** 子智能体调用次数（delegate + critic），只统计 */
  subagentCalls: number
}
```

```ts
export interface AgentToolDeps {
  apiKey: string
  imageApiKey: string | null
  model: string
  budget: RunBudget
  plan: PlanBridge
  onGate: (gate: AgentGate) => void
  /** 当前 run id：资料卡用它判断「本 run 可读」 */
  getRunId: () => string
  /** 子智能体 runner；run-service 注入。缺省时 delegate 直接失败 */
  subagent?: (req: SubagentRequest) => Promise<SubagentResult>
  /** critic 门禁；只在 INKLOOM_CRITIC=on 时注入 */
  critic?: (input: CriticInput) => Promise<CriticVerdict>
}
```

顶部 import 追加：

```ts
import type { CriticInput, CriticVerdict } from './critic.js'
import { isAgentRoleId } from './roles.js'
import type { SubagentRequest, SubagentResult } from './subagent.js'
```

- [ ] **Step 4: 加 `DELEGATE` 参数与 `delegateTool`**

在 `READ_LORE` 之后追加：

```ts
const DELEGATE = Type.Object({
  // 显式四个 Literal：与 roles.ts 的 AgentRoleId 一一对应，新增角色必须两边一起改
  role: Type.Union([
    Type.Literal('researcher'),
    Type.Literal('worldbuilder'),
    Type.Literal('critic'),
    Type.Literal('stylist'),
  ]),
  task: Type.String({ minLength: 1, maxLength: 500, description: '具体要它做什么，一次一件事' }),
  context: Type.Optional(
    Type.String({ maxLength: 2000, description: '需要它知道的背景；它看不到你的对话历史' }),
  ),
})
```

在 `readLoreTool` 之后、`writeElementTool` 之前插入工具：

```ts
  const delegateTool: AgentTool<typeof DELEGATE> = {
    name: 'delegate',
    label: '派子智能体',
    description:
      '把一个只读子任务派给专家子智能体并等它跑完：researcher=联网考据，worldbuilder=审设定与图谱缺口，critic=查一致性，stylist=文风建议。它看不到你的对话历史，也不写文件；需要背景请写进 context。',
    parameters: DELEGATE,
    execute: async (_id, params) => {
      if (deps.subagent === undefined) return fail('这个会话没有启用子智能体')
      if (!isAgentRoleId(params.role)) return fail(`未知角色：${params.role}`)
      const r = await deps.subagent({
        role: params.role,
        task: params.task,
        ...(params.context === undefined ? {} : { context: params.context }),
      })
      if (!r.ok) {
        const partial = r.text.length === 0 ? '' : `\n\n已产出的部分结论：\n${r.text.slice(0, 1000)}`
        return fail(
          `[${r.role}] 子任务失败：${r.error ?? '未知原因'}。可以换一种方式，或自己继续。${partial}`,
        )
      }
      return ok(
        `[${r.role}] 用了 ${r.steps} 步，${r.tokens.toLocaleString()} tokens。\n摘要：\n${r.text.slice(0, 4000)}`,
        { role: r.role, ok: r.ok, steps: r.steps, tokens: r.tokens },
      )
    },
  }
```

在 `return [` 数组里、`readLoreTool,` 之后插入 `delegateTool,`。

- [ ] **Step 5: 改 `update_task` 的 done 分支**

把 `updateTaskTool` 里 `const artifacts = ...` 到 `const next =` 之间的 artifacts 校验保留，紧跟其后插入：

```ts
      let criticNote = ''
      if (params.status === 'done' && deps.critic !== undefined) {
        const verdict = await deps.critic({
          taskId: task.id,
          title: task.title,
          brief: task.brief,
          artifacts,
          summary: params.note ?? cur.summary,
          goal: bundle.plan.goal,
        })
        if (verdict.kind === 'blocked') {
          const lines = verdict.errors.map(
            (c, i) => `${i + 1}. ${c.message}（证据：${c.evidence.join('、')}）`,
          )
          const warns =
            verdict.warnings.length === 0 ? '' : `\n另有 ${verdict.warnings.length} 处提示。`
          return fail(
            `一致性检查发现 ${verdict.errors.length} 处矛盾，任务保持未完成：\n${lines.join('\n')}${warns}\n修好后重新调用 update_task(status="done")。`,
            { taskId: task.id, blocked: true, conflicts: verdict.errors.length },
          )
        }
        if (verdict.kind === 'passed') {
          const sug =
            verdict.suggestions.length === 0
              ? ''
              : `；建议：${verdict.suggestions.slice(0, 3).join('；')}`
          criticNote = `一致性检查通过（${verdict.warnings.length} 处提示${sug}）。`
        } else {
          criticNote = `一致性检查未完成：${verdict.reason}。`
        }
      }
```

并把最后的返回改成：

```ts
      return ok(
        `任务 ${task.id} → ${params.status}${params.note === undefined ? '' : `（${params.note}）`}。${criticNote}${hint}`,
        { taskId: task.id, status: params.status },
      )
```

- [ ] **Step 6: 让子智能体读得到正文（`read_element` 放行 `chapters/`）**

审查发现 stylist / critic 的只读工具集拿不到正文：`read_element` 目前只允许 `characters|world|story`，而正文在 `chapters/ch-001.md` 与 `chapters/ch-001/scenes/s1.v1.md`。

在 `tools.ts` 的 `read_element` 里把路径校验与读取改成：

```ts
      const rel = params.path
      if (!/^(characters|world|story|chapters)\//.test(rel) || rel.includes('..')) {
        return fail(`路径不可读：${rel}。只能是 characters/、world/、story/、chapters/ 下的文件`)
      }
      // ★ 章节是 Markdown：返回原文，不做 JSON 化（否则模型看到的是转义后的字符串）
      if (rel.startsWith('chapters/')) {
        const raw = await readIfExists(join(root, rel))
        if (raw === null) return fail(`文件不存在：${rel}`)
        const text = raw.length > 30_000 ? `${raw.slice(0, 30_000)}\n…（已截断）` : raw
        return ok(text, { path: rel, hash: hashContent(raw), format: 'text' })
      }
      const data = await readElement(rel)
      if (data === null) return fail(`文件不存在：${rel}`)
      const raw = (await readIfExists(join(root, rel))) ?? ''
      // ……其余不变（JSON 分支保持原样）
```

在 `apps/api/src/agent/delegate-tools.test.ts` 追加（顶部 import 补 `mkdir` / `writeFile`）：

```ts
describe('read_element 读正文', () => {
  it('★ 章节 Markdown 原样返回，不再是「文件不存在」', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(join(root, 'chapters', 'ch-001.md'), '# 第 1 章\n\n林岚御剑而行。', 'utf8')
    const r = await tool('read_element').execute('c1', { path: 'chapters/ch-001.md' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('林岚御剑而行')
  })
})
```

Run: `pnpm vitest run --project unit apps/api/src/agent/delegate-tools.test.ts`
Expected: PASS（含新用例）

- [ ] **Step 7: 补 `subagentCalls` 到已有测试的 budget 字面量**

`apps/api/src/agent/plan-tools.test.ts` 里的：

```ts
const budget: RunBudget = {
  steps: 0,
  maxSteps: 40,
  chapterCalls: 0,
  portraitCalls: 0,
}
```

改为末尾加 `subagentCalls: 0,`。

- [ ] **Step 8: 跑新测试与既有计划测试**

Run: `pnpm vitest run --project unit apps/api/src/agent/delegate-tools.test.ts apps/api/src/agent/plan-tools.test.ts`
Expected: PASS — delegate-tools 7 passed、plan-tools 全绿

- [ ] **Step 9: 类型与格式检查**

Run: `pnpm tsc --build tsconfig.base.json`
Expected: 无输出

Run: `pnpm exec biome check apps/api/src/agent/tools.ts apps/api/src/agent/delegate-tools.test.ts`
Expected: 无错误（若有格式问题，`pnpm exec biome check --write <文件>` 后重跑）

- [ ] **Step 10: 提交**

```bash
git add apps/api/src/agent/tools.ts apps/api/src/agent/delegate-tools.test.ts apps/api/src/agent/plan-tools.test.ts
git commit -m "feat(agent): add delegate tool and critic gate on task completion"
```

---

### Task 5: run-service 接线（runner、critic、事件、token）

**Files:**
- Modify: `apps/api/src/agent/critic.ts`（新增 `criticEnabled`）
- Modify: `apps/api/src/agent/critic.test.ts`（补 2 例）
- Modify: `apps/api/src/agent/run-service.ts`（`AgentStreamPayload` 三个事件、budget 初始化、runner 组装、critic 注入）
- Modify: `apps/api/src/agent/run-service.test.ts`（关闭 critic 的默认干扰 + 事件转发用例）

**Interfaces:**
- Consumes: `createSubagentRunner`（Task 2）、`parseCriticReport` / `decideCritic` / `criticEnabled`（Task 3）、`AgentToolDeps.subagent/critic`（Task 4）
- Produces:
  - `AgentStreamPayload` 新增 `subagent.started` / `subagent.tool` / `subagent.ended`
  - `RunBudget` 初始化时带 `subagentCalls: 0`
  - `INKLOOM_CRITIC` 在 `startAgentRun` 时解析（默认开）

- [ ] **Step 1: 先写 criticEnabled 的测试**

在 `apps/api/src/agent/critic.test.ts` 顶部 import 改为：

```ts
import { criticEnabled, decideCritic, parseCriticReport } from './critic.js'
```

末尾追加：

```ts
describe('criticEnabled', () => {
  it('★ 默认开；只有显式 off 才关', () => {
    expect(criticEnabled(undefined)).toBe(true)
    expect(criticEnabled('')).toBe(true)
    expect(criticEnabled('on')).toBe(true)
    expect(criticEnabled('OFF')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/critic.test.ts`
Expected: FAIL — `criticEnabled is not a function`（或 TS 报错未导出）

- [ ] **Step 3: 实现 criticEnabled**

在 `apps/api/src/agent/critic.ts` 末尾追加：

```ts
/** 默认开：不设置就检查；只有显式 off 才关（与设置页的 on/off 一致） */
export function criticEnabled(raw: string | undefined): boolean {
  return (raw ?? 'on').trim().toLowerCase() !== 'off'
}
```

跑：`pnpm vitest run --project unit apps/api/src/agent/critic.test.ts`
Expected: PASS — 6 passed

- [ ] **Step 4: 加事件类型**

在 `apps/api/src/agent/run-service.ts` 的 `AgentStreamPayload` union 里、`plan.updated` 之后插入：

```ts
  | { type: 'subagent.started'; id: string; role: AgentRoleId; task: string }
  | {
      type: 'subagent.tool'
      id: string
      role: AgentRoleId
      toolName: string
      ok: boolean
      summary: string
    }
  | {
      type: 'subagent.ended'
      id: string
      role: AgentRoleId
      ok: boolean
      steps: number
      tokens: number
      summary: string
    }
```

顶部 import 追加（`AgentTool` 已在现有第 4 行的 `import { Agent, type AgentTool, type AgentEvent as PiEvent }` 里，**不要重复添加**）：

```ts
import {
  criticEnabled,
  decideCritic,
  parseCriticReport,
  type CriticInput,
  type CriticVerdict,
} from './critic.js'
import type { AgentRoleId } from './roles.js'
import { createSubagentRunner } from './subagent.js'
```

- [ ] **Step 5: budget 初始化加字段**

`startAgentRun` 里：

```ts
  const budget: RunBudget = {
    steps: 0,
    maxSteps: 80,
    chapterCalls: 0,
    portraitCalls: 0,
    subagentCalls: 0,
  }
```

- [ ] **Step 6: 组装 runner 与 critic，注入工具**

把 `let run!: AgentRun` 到 `const tools = createAgentTools({...})` 之间的代码替换为下面的结构（保留原有 `apiKey` / `imageApiKey` / `model` / `plan` / `onGate` / `getRunId` 的值）：

```ts
  let run!: AgentRun
  // ★ runner 需要「工具全集」，工具又需要 runner：用惰性 getter 打破构造期循环。
  //   只有 delegate / critic 执行时才会读到 allTools，那时它已经赋值。
  let allTools: AgentTool[] = []
  const subagent = createSubagentRunner({
    model,
    streamFn: models().streamSimple.bind(models()),
    getTools: () => allTools,
    budget,
    onEvent: (e) => {
      if (e.type === 'started') {
        emit(run, { type: 'subagent.started', id: e.id, role: e.role, task: e.task })
        return
      }
      if (e.type === 'tool') {
        emit(run, {
          type: 'subagent.tool',
          id: e.id,
          role: e.role,
          toolName: e.toolName,
          ok: e.ok,
          summary: e.summary,
        })
        return
      }
      emit(run, {
        type: 'subagent.ended',
        id: e.id,
        role: e.role,
        ok: e.ok,
        steps: e.steps,
        tokens: e.tokens,
        summary: e.summary,
      })
    },
    onTokens: (n) => {
      run.tokens += n
    },
  })

  const critic = criticEnabled(process.env['INKLOOM_CRITIC'])
    ? async (input: CriticInput): Promise<CriticVerdict> => {
        const task = [
          '# 任务',
          `检查任务 ${input.taskId}「${input.title}」的完成情况是否与本书设定矛盾。`,
          `任务要求：${input.brief.length === 0 ? '（未填）' : input.brief}`,
          `本次产物：${input.artifacts.length === 0 ? '（未填）' : input.artifacts.join('、')}`,
          `主 Agent 的完成说明：${input.summary ?? '（无）'}`,
          '',
          '先用 read_book 看设定全貌，需要时用 query_graph / explain_fact 核对具体关系。',
        ].join('\n')
        const r = await subagent({ role: 'critic', task })
        if (!r.ok) return { kind: 'skipped', reason: r.error ?? '子智能体失败' }
        return decideCritic(parseCriticReport(r.text))
      }
    : undefined

  const tools = createAgentTools({
    apiKey,
    imageApiKey: imageApiKey === null || imageApiKey.length === 0 ? null : imageApiKey,
    model: model.id,
    budget,
    plan: {
      getPlanId: () => run.planId,
      setPlanId: (planId) => {
        run.planId = planId
      },
      notify: (plan) => {
        refreshPlanBudget(run, plan)
        emit(run, { type: 'plan.updated', plan })
      },
    },
    onGate: (gate) => {
      gateBox.current = gate
    },
    getRunId: () => run.id,
    subagent,
    ...(critic === undefined ? {} : { critic }),
  })
  allTools = tools
```

同时把顶部 import 补上 critic 类型（已在 Step 4 的 import 块里；不要写第二行 import）。

- [ ] **Step 7: 让既有 run 测试不受默认 critic 影响**

`apps/api/src/agent/run-service.test.ts` 的 `beforeEach` 里加一行：

```ts
  process.env['INKLOOM_CRITIC'] = 'off'
```

`afterEach` 里加：

```ts
  delete process.env['INKLOOM_CRITIC']
```

- [ ] **Step 8: 加事件转发用例**

在 `apps/api/src/agent/run-service.test.ts` 末尾追加：

```ts
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
    const types = (snap?.events ?? [])
      .map((e) => e.type)
      .filter((t) => t.startsWith('subagent.'))
    expect(types).toEqual(['subagent.started', 'subagent.ended'])
    expect(snap?.tokens).toBe(15)
    expect(snap?.budget.subagentCalls).toBe(1)
  })
})
```

- [ ] **Step 9: 跑测试与类型检查**

Run: `pnpm vitest run --project unit apps/api/src/agent/run-service.test.ts apps/api/src/agent/critic.test.ts`
Expected: PASS — run-service 全绿、critic 6 passed

Run: `pnpm tsc --build tsconfig.base.json`
Expected: 无输出

- [ ] **Step 10: 提交**

```bash
git add apps/api/src/agent/run-service.ts apps/api/src/agent/run-service.test.ts apps/api/src/agent/critic.ts apps/api/src/agent/critic.test.ts
git commit -m "feat(agent): wire subagent runner, critic gate and event stream"
```

---

### Task 6: 前端卡片、设置开关与真机验收

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/pages/AgentPage.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/api/src/routes/settings.ts`
- Modify: `README.md:225`

**Interfaces:**
- Consumes: Task 5 的三个 `subagent.*` 事件、`RunBudget.subagentCalls`
- Produces: 子智能体折叠卡片、预算行的子体计数、`INKLOOM_CRITIC` 设置项

- [ ] **Step 1: 前端类型同步**

`apps/web/src/api/types.ts`：

1. 在 `AgentRunBudget` 加：

```ts
  subagentCalls: number
```

2. 新增（放在 `AgentRunBudget` 之前）：

```ts
export type AgentRoleId = 'researcher' | 'worldbuilder' | 'critic' | 'stylist'
```

3. 在 `AgentEvent` union 的 `plan.updated` 之后插入：

```ts
  | { seq: number; at: string; type: 'subagent.started'; id: string; role: AgentRoleId; task: string }
  | {
      seq: number
      at: string
      type: 'subagent.tool'
      id: string
      role: AgentRoleId
      toolName: string
      ok: boolean
      summary: string
    }
  | {
      seq: number
      at: string
      type: 'subagent.ended'
      id: string
      role: AgentRoleId
      ok: boolean
      steps: number
      tokens: number
      summary: string
    }
```

- [ ] **Step 2: AgentPage 的 Block 与标签**

`apps/web/src/pages/AgentPage.tsx`：

1. import 的类型里加 `AgentRoleId`。
2. `Block` union 在 tool 之后加：

```ts
  | {
      kind: 'subagent'
      id: string
      role: AgentRoleId
      task: string
      status: 'running' | 'done' | 'failed' | 'stopped'
      steps: number
      tokens: number
      tools: { name: string; ok: boolean; summary: string }[]
      summary: string
    }
```

3. `TOOL_LABEL` 加：

```ts
  delegate: '派子智能体',
```

4. 在 `TOOL_LABEL` 之后加：

```ts
const ROLE_LABEL: Record<AgentRoleId, string> = {
  researcher: '研究员',
  worldbuilder: '世界建筑师',
  critic: '一致性检查员',
  stylist: '文风顾问',
}
```

- [ ] **Step 3: settleRunningTools 与 reduce**

1. `settleRunningTools` 改成 if 链，覆盖子体：

```ts
function settleRunningTools(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.kind === 'tool' && b.status === 'running') {
      return {
        ...b,
        status: 'stopped' as const,
        summary: b.summary.length > 0 ? b.summary : '本轮已结束，结果未知',
      }
    }
    if (b.kind === 'subagent' && b.status === 'running') {
      return { ...b, status: 'stopped' as const }
    }
    return b
  })
}
```

2. `reduce` 在 `case 'plan.updated':` 之前插入：

```ts
    case 'subagent.started': {
      const last = blocks[blocks.length - 1]
      const head =
        last?.kind === 'thinking' ? [...blocks.slice(0, -1), { ...last, done: true }] : blocks
      return [
        ...head,
        {
          kind: 'subagent',
          // 加前缀避免与 toolCallId 撞 id
          id: `sa:${ev.id}`,
          role: ev.role,
          task: ev.task,
          status: 'running',
          steps: 0,
          tokens: 0,
          tools: [],
          summary: '',
        },
      ]
    }
    case 'subagent.tool': {
      return blocks.map((b) =>
        b.kind === 'subagent' && b.id === `sa:${ev.id}`
          ? { ...b, tools: [...b.tools, { name: ev.toolName, ok: ev.ok, summary: ev.summary }] }
          : b,
      )
    }
    case 'subagent.ended': {
      return blocks.map((b) =>
        b.kind === 'subagent' && b.id === `sa:${ev.id}`
          ? {
              ...b,
              status: ev.ok ? ('done' as const) : ('failed' as const),
              steps: ev.steps,
              tokens: ev.tokens,
              summary: ev.summary,
            }
          : b,
      )
    }
```

- [ ] **Step 4: 渲染子智能体卡片**

在 `blocks.map` 的 `if (b.kind === 'tool') { ... }` 之后、`if (b.kind === 'status')` 之前插入：

```tsx
                if (b.kind === 'subagent') {
                  const tone =
                    b.status === 'running'
                      ? 'border-sky-200 bg-sky-50'
                      : b.status === 'failed'
                        ? 'border-rose-200 bg-rose-50'
                        : 'border-neutral-200 bg-white'
                  return (
                    <details key={b.id} className={`rounded border px-3 py-2 ${tone}`}>
                      <summary className="flex cursor-pointer items-center gap-2 text-[12px]">
                        <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-800">
                          {ROLE_LABEL[b.role]}
                        </span>
                        <span className="truncate text-neutral-700">{b.task}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-neutral-500">
                          {b.status === 'running'
                            ? '执行中…'
                            : b.status === 'stopped'
                              ? '已停止'
                              : b.status === 'failed'
                                ? '失败'
                                : '完成'}
                          {` · ${b.steps} 步 · ${b.tokens.toLocaleString()} tokens`}
                        </span>
                      </summary>
                      {b.tools.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {b.tools.map((t, i) => (
                            <li key={`${b.id}-${i}`} className="text-[11px] text-neutral-600">
                              <span className={t.ok ? 'text-emerald-700' : 'text-rose-700'}>
                                {TOOL_LABEL[t.name] ?? t.name}
                              </span>
                              {t.summary.length > 0 && ` · ${t.summary}`}
                            </li>
                          ))}
                        </ul>
                      )}
                      {b.summary.length > 0 && (
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-[11px] leading-5 text-neutral-600">
                          {b.summary}
                        </pre>
                      )}
                    </details>
                  )
                }
```

- [ ] **Step 5: 预算行加子体计数**

把 `AgentPage.tsx` 里的：

```tsx
              <p>
                步数 {run.budget.steps}/{run.budget.maxSteps} · 章节 {run.budget.chapterCalls} · 图{' '}
                {run.budget.portraitCalls}
              </p>
```

改为：

```tsx
              <p>
                步数 {run.budget.steps}/{run.budget.maxSteps} · 子智能体{' '}
                {run.budget.subagentCalls} 次 · 章节 {run.budget.chapterCalls} · 图{' '}
                {run.budget.portraitCalls}
              </p>
```

- [ ] **Step 6: 设置页与设置接口**

1. `apps/api/src/routes/settings.ts`：
   - `WRITABLE` 数组加 `'INKLOOM_CRITIC',`（放在 `INKLOOM_JUDGE_MODEL` 之后）。
   - `DEFAULTS` 加 `INKLOOM_CRITIC: 'on',`。
   - `settings.put` 的校验里、`INKLOOM_JUDGE` 分支之后加：

```ts
    if (k === 'INKLOOM_CRITIC' && !['on', 'off'].includes(v)) {
      throw new InkloomError('INVALID_INPUT', 'INKLOOM_CRITIC 只能是 on / off')
    }
```

2. `apps/web/src/pages/SettingsPage.tsx`：
   - `GROUPS` 末尾加一组：

```ts
  {
    title: '共创',
    hint: '一致性检查默认开：每个任务 done 前让 critic 核对一次，发现矛盾会挡住完成。',
    keys: ['INKLOOM_CRITIC'],
  },
```

   - `LABEL` 加 `INKLOOM_CRITIC: '任务后一致性检查',`。
   - `Field` 里加 `const isCritic = field.key === 'INKLOOM_CRITIC'`，并把 isJudge 那个 select 结束后的 `) : (` 替换为下面的 `) : isCritic ? (…select…) : (`：

```tsx
      ) : isCritic ? (
        <select
          id={field.key}
          value={value !== '' ? value : field.value || 'on'}
          onChange={(e) => onChange(e.target.value)}
          className="w-56 rounded border border-neutral-300 px-2 py-1 text-[12px]"
        >
          <option value="on">on（每个任务检查一次）</option>
          <option value="off">off（关闭，省 token）</option>
        </select>
```

- [ ] **Step 7: 前后端类型与构建检查**

Run: `pnpm tsc`
Expected: 无输出

Run: `pnpm exec biome check apps/web/src apps/api/src/routes/settings.ts`
Expected: 无错误（有格式问题先 `pnpm exec biome check --write <路径>`）

Run: `pnpm --filter @inkloom/web build`
Expected: 构建成功（bundle 大小与切片 2 相近）

- [ ] **Step 8: 全量回归**

Run: `pnpm verify`
Expected: biome / tsc / check-deps / 单元 / 集成全部通过

- [ ] **Step 9: 真机验收（真实模型）**

准备书库（仓库根执行）：

```powershell
New-Item -ItemType Directory -Force .tmp-library | Out-Null
Copy-Item -Recurse fixtures/qixia .tmp-library/qixia
```

启动 API（保留终端）：

```powershell
$env:INKLOOM_LIBRARY=".tmp-library"; pnpm api
```

另开终端启动前端：`pnpm web`。

在浏览器（Playwright，`browser_run_code_unsafe` 真实鼠标 + 绝对路径截图）依次验证：

1. 打开书库页 → 打开「七霞」→ 进「共创」。
2. 开始一个会话，等计划批准后，对 Agent 说：「先派研究员查一下唐代驿站的传递制度，再继续」。
   - 期望：对话流出现「研究员」折叠卡片；展开有 `联网搜索` / `读网页` 条目；结束时显示步数与 tokens。
3. 制造一处矛盾再验收 critic：
   - 直接在书里把 `characters/index.json` 中某个角色的名字改掉（例如把「林岚」改成「林澜」），不要同步正文。
   - 让 Agent 完成一个会引用该角色的任务并 `update_task(done)`。
   - 期望：任务停在 `doing`，工具返回「一致性检查发现 N 处矛盾」并列出证据；修正后重试能通过。
4. 关闭开关复验：设置页把「任务后一致性检查」改为 `off`，保存后重开一个会话，同样的任务直接 `done`，返回文本含「一致性检查未完成」以外的正常提示（无检查）。
5. 截图存入 `docs/screenshots/accept-multi-agent.png`（1440×900）。

若 critic 未命中矛盾（模型判断保守），把矛盾改得更直白（姓名/境界直接冲突）后重试一次；仍不命中则如实记录，不伪造通过。

- [ ] **Step 10: 更新 README**

1. 在「共创」相关章节补一条：

```markdown
- 子智能体：主 Agent 可派「研究员 / 世界建筑师 / 一致性检查员 / 文风顾问」四个只读子任务；每个任务 `done` 前自动做一次一致性检查，矛盾会挡住完成（设置页可关）
```

2. 把 [README.md:225](file:///d:/Qwen-Agent/writing_test/test-1/README.md#L225) 的计数改为本次 `pnpm verify` 的实际输出（当前是 `385 单元 + 339 集成`，只改数字，不改句式）。

- [ ] **Step 11: 提交**

```bash
git add apps/web/src/api/types.ts apps/web/src/pages/AgentPage.tsx apps/web/src/pages/SettingsPage.tsx apps/api/src/routes/settings.ts README.md docs/screenshots/accept-multi-agent.png
git commit -m "feat(web): show subagent cards and critic switch"
```

---

## Self-Review

**1. Spec coverage**

| spec 章节 | 覆盖任务 |
|---|---|
| §3 角色定义 / 白名单 | Task 1 |
| §4 运行器（步数、超时、事件、token） | Task 2 |
| §5 `delegate` 工具 | Task 4 |
| §6 critic 解析与三态门禁 | Task 3 + Task 4 |
| §7 事件与前端卡片、预算行 | Task 5（事件）+ Task 6（UI） |
| §8 设置开关 | Task 6 |
| §9 测试 | 每个任务自带 |
| §10 验收标准 1–5 | Task 6 Step 8–9 |
| §2 不做（并行、自定义角色、新依赖） | Global Constraints 明确禁止 |

**2. Placeholder scan**

- 无 TBD / TODO / 「类似 Task N」；每个代码步骤都给了可直接粘贴的实现。
- Task 6 Step 9 的验收含「若未命中则如实记录」，这是验收失败时的处理规则，不是占位符。

**3. Type consistency**

- `SubagentEvent.ended` 的 `summary` 在 Task 2 实现、Task 5 事件转发、Task 6 前端 Block 三处同名同义。
- `CriticVerdict` 三个分支在 Task 3 定义、Task 4 消费、Task 5 包装处返回，字段名一致。
- `RunBudget.subagentCalls` 在 Task 4 定义、Task 4 测试、Task 5 初始化、Task 6 前端类型与预算行一致。
- 子体 Block 的 `id` 统一是 `sa:${event.id}`，三个 reduce 分支与渲染都用同一前缀。
