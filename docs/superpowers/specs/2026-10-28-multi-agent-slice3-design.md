# 切片 3：多智能体（角色子智能体）Implementation Design

日期：2026-10-28
状态：待用户审阅
前置：[共创与图谱 v2 设计](./2026-10-27-creator-and-graph-v2-design.md) §6（角色表、delegate 参数、critic 输出格式、UI 形态已定；本文件补齐实现契约与本轮新决策）

## 0. 一句话

主 Agent 保留唯一写权限与计划编排；`delegate` 工具按角色起一个**独立、只读、步数受限**的 Pi Agent 子会话，同步跑完把结论带回主对话；每个任务 `done` 前由 critic 自动做一次一致性检查，发现 `error` 级矛盾就挡住 `done`。

## 1. 已确认决策

| 问题 | 决策 | 理由 |
|---|---|---|
| critic 自己跑挂（超时/坏 JSON/超步数） | **放行 `done`，并在工具返回里写明「一致性检查未完成：原因」** | 检查器故障不该卡住作者推进；但绝不假装检查过 |
| `INKLOOM_CRITIC` 默认值 | **`on`** | 开箱即满足验收；成本靠每任务一次 + `maxSteps=5` 控制，设置页可关 |
| 子体上下文 | **隔离**：只有 `systemPrompt + task + context`，不继承主对话 | 上下文干净、便宜、职责清晰；主 Agent 必须把必要背景写进 `context` |
| 阻断条件 | 只有 `severity='error'` 阻断；`warning` 一律放行 | 风格意见不该反复卡任务（父 spec §6.3） |

## 2. 范围

### 做

- `roles.ts`：四个角色的 systemPrompt、工具白名单、步数上限、输出类型
- `subagent.ts`：独立 Pi Agent 运行器（步数、超时、事件、token）
- `delegate` 工具（主 Agent 唯一新增工具）
- `update_task(status='done')` 内置 critic 门禁 + 设置页开关
- 子智能体事件（`subagent.*`）与前端折叠卡片、预算行的子体计数
- `RunBudget.subagentCalls`（只计数，不拦截）

### 不做

- 并行子体、子体之间互相委派、子体写文件
- 角色自定义 / 角色市场（`roles.ts` 写死四个）
- 子体继承主对话历史或摘要
- 新增 Prisma 表、新增 npm 依赖
- 改 `write_element` / `request_review` / 门禁流程

## 3. 角色定义 `apps/api/src/agent/roles.ts`

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

export const AGENT_ROLES: Record<AgentRoleId, AgentRole>
export const AGENT_ROLE_IDS: readonly AgentRoleId[]

export function isAgentRoleId(v: string): v is AgentRoleId
/** 按白名单过滤主 Agent 的工具全集；白名单里没有的名字直接跳过（不报错） */
export function toolsForRole(role: AgentRole, all: readonly AgentTool[]): AgentTool[]
```

| 角色 | 职责 | 白名单 | maxSteps | output |
|---|---|---|---|---|
| `researcher` | 联网找资料、读网页、整理资料卡 | `web_search` `read_url` `read_lore` `read_book` | 6 | text |
| `worldbuilder` | 读设定与图谱，给「该补哪些节点/边/规则」的建议 | `read_book` `read_element` `query_graph` `find_path` | 5 | text |
| `critic` | 只读一致性检查：本次产物 vs 设定/图谱 | `read_book` `read_element` `query_graph` `find_path` `explain_fact` | 5 | json |
| `stylist` | 文风与对话建议，不改正文 | `read_book` `read_element` | 4 | text |

**systemPrompt 必须写死的约束**

- 通用（四个角色都写）：你没有写权限，不要建议自己调用写工具；只用工具返回的事实，不要编造文件内容；结论要能被作者直接使用。
- `researcher`：每个结论附来源 URL 或资料卡 id；搜不到就说搜不到，不要用常识补。
- `worldbuilder`：建议必须落到具体 `id` / `type` / 是否已存在；只给建议，不写文件。
- `critic`：只报矛盾不报喜好；每条必须给 `evidence`（文件相对路径或节点 id）；没有矛盾就返回空数组；**只输出 JSON，不要解释文字**。输出契约见 §6。
- `stylist`：只给可执行的局部建议（删哪句、换哪个词），不重写整段。

## 4. 运行器 `apps/api/src/agent/subagent.ts`

```ts
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'

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
  /** Pi 模型对象（@earendil-works/pi-ai 的 Model<any>，与主 Agent 同一个） */
  model: Model<any>
  streamFn: StreamFn
  /** 工具全集用惰性 getter：runner 在 delegate 执行期才取，避免与 createAgentTools 循环依赖 */
  getTools: () => readonly AgentTool[]
  budget: RunBudget
  onEvent: (e: SubagentEvent) => void
  onTokens: (n: number) => void
  /** 默认 120_000 */
  timeoutMs?: number
}

export function createSubagentRunner(
  deps: SubagentRunnerDeps,
): (req: SubagentRequest) => Promise<SubagentResult>
```

**行为契约**

1. 每次调用 `budget.subagentCalls += 1`，生成 `id = 'sa_' + randomUUID().slice(0, 12)`。
2. 起**独立** `new Agent`：`systemPrompt = role.systemPrompt + 任务块 + 背景块`，`thinkingLevel: 'low'`，`toolExecution: 'sequential'`，工具 = `toolsForRole(role, deps.getTools())`。
3. `beforeToolCall`：
   - 主会话 `budget.steps >= budget.maxSteps` → `{ block: true, terminate: true, reason: '主会话步数预算已用尽' }`
   - 子体 `subSteps >= role.maxSteps` → `{ block: true, terminate: true, reason: '子任务步数上限（N 步）' }`
   - 否则 `budget.steps += 1; subSteps += 1`
   - 同一批次内所有调用都会命中同一判断，所以 `terminate` 一定生效。
4. 事件：`started` → 每次工具结束一条 `tool`（`summary` 用 `clip(text, 160)`）→ `ended`（无论成功失败都发，且只发一次；`summary` 是结果文本前 400 字，取不到就为空串）。
5. 文本：取**最后一条非空 assistant 文本**（多轮工具调用时最后一条是总结），超过 6000 字截断并注明原长。
6. token：每条 assistant `message_end` 的 `usage.input + usage.output` 累加，同时调 `deps.onTokens(n)`。
7. 超时：`setTimeout(timeoutMs)` 触发 `agent.abort()` 并标记 `timedOut`；结果 `ok=false, error=\`子任务超时（${timeoutMs}ms）\``。
8. 失败：`prompt()` 抛错或 `agent.state.errorMessage` 非空 → `ok=false, error=原因`；**永不向调用方抛异常**（delegate / critic 自己决定策略）。

## 5. `delegate` 工具（`tools.ts` 新增）

```ts
parameters: Type.Object({
  // 显式四个 Literal：与 roles.ts 的 AgentRoleId 一一对应，新增角色必须两边一起改
  role: Type.Union([
    Type.Literal('researcher'),
    Type.Literal('worldbuilder'),
    Type.Literal('critic'),
    Type.Literal('stylist'),
  ]),
  task: Type.String({ maxLength: 500 }),
  context: Type.Optional(Type.String({ maxLength: 2000 })),
})
```

**执行**

1. `deps.subagent === undefined` → `fail('这个会话没有启用子智能体')`。
2. 调 `deps.subagent({ role, task, context })`；`role` 非法时 `fail` 列出合法值。
3. 成功返回（对齐父 spec §6.2）：

```
[researcher] 用了 3 步，2,140 tokens。
摘要：
<text 前 4000 字>
```

4. 失败返回 `fail('[researcher] 子任务失败：<error>。可以换一种方式，或自己继续。')`，附已产出的 `text` 前 1000 字。
5. `details` = `{ role, ok, steps, tokens }`。
6. delegate 自身计 1 步（主 `beforeToolCall` 负责）；子体每次工具调用再计入主 `budget.steps`。

**递归防护**：白名单不含 `delegate`，子体拿到的工具里根本没有它；`roles.test.ts` 断言。

## 6. critic 门禁

### 6.1 输出契约（`apps/api/src/agent/critic.ts`）

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

/** 剥 ```json 围栏 → JSON.parse → 结构校验；任何一步失败返回 null（调用方按 skipped 处理） */
export function parseCriticReport(text: string): CriticReport | null
/** 纯函数：只有 error 阻断 */
export function decideCritic(report: CriticReport | null): CriticVerdict
```

- **不新增 zod 依赖**：`apps/api` 只有 typebox，这里用手写结构校验（字段类型、`severity` 枚举、`evidence` 必须是字符串数组）。结构不合法一律返回 `null`，不做猜测性修正；结构合法但 `evidence` 为空的 conflict 在返回前丢弃——没有证据的矛盾不采信。
- `decideCritic(null)` → `{ kind: 'skipped', reason: '返回内容不是合法 JSON' }`。

### 6.2 接入点 `update_task(done)`

`AgentToolDeps` 扩展（可选字段，`exactOptionalPropertyTypes` 下用条件展开注入）：

```ts
export interface AgentToolDeps {
  // ...现有字段
  subagent?: (req: SubagentRequest) => Promise<SubagentResult>
  critic?: (input: CriticInput) => Promise<CriticVerdict>
}
```

`update_task` 的 `done` 分支顺序：

1. 现有 artifacts 存在性校验（先做，避免为坏路径烧一次 critic）。
2. `deps.critic` 存在 → `const verdict = await deps.critic({ ... })`。
3. 按 verdict 决定：

| verdict | 行为 |
|---|---|
| `blocked` | 返回 `fail('一致性检查发现 N 处矛盾：…（每条含 evidence）… 修好后重新调用 update_task(status="done")')`；**不写 state**，任务保持调用前的状态（通常是 `doing`） |
| `passed` | 写 `done`，返回值追加 `一致性检查通过（N 处提示）` + 建议前 3 条 |
| `skipped` | 写 `done`，返回值追加 `一致性检查未完成：<reason>` |

4. `deps.critic` 不存在（开关关闭）→ 与现状一致，直接写 `done`。

### 6.3 critic 的输入构造

`run-service` 注入的 `critic` 包装负责：

- 由 `CriticInput` 拼 task 文本：任务标题、目标、brief、artifacts 列表、主 Agent 写的 summary。
- 调 `subagent({ role: 'critic', task })`；`ok=false` → `{ kind: 'skipped', reason: error }`。
- `parseCriticReport(result.text)` → `decideCritic(...)`。
- critic 的工具调用同样计入主 `budget.steps` 与 `subagentCalls`。

## 7. 事件与前端

### 7.1 新事件（`run-service.ts` 与 `apps/web/src/api/types.ts` 两份同步）

```ts
| { type: 'subagent.started'; id: string; role: AgentRoleId; task: string }
| { type: 'subagent.tool'; id: string; role: AgentRoleId; toolName: string; ok: boolean; summary: string }
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

- 只在 `delegate` / critic 的运行期发；`subagent.tool` 不进 journal 的 delta 洪流（每个工具一条，一次子体最多 6 条）。
- `RunBudget` 加 `subagentCalls`（API + web 两份），预算行显示。

### 7.2 `AgentPage` 的 Block

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

- `subagent.started` 追加 block；`subagent.tool` 往对应 id 的 `tools` 追加；`subagent.ended` 更新状态/步数/tokens，并把 `summary` 写成事件里带的结果摘要（前 400 字）。
- `settleRunningTools` 同步把 `running` 的子体卡标成 `stopped`，避免停止/失败后永远转圈。
- 卡片默认折叠：标题行 `研究员 · 查唐代驿站制度 · 3 步 · 2,140 tokens`；展开显示工具列表（名称 + 一行摘要）与结果摘要。
- 预算行改为：`步数 12/96 · 子智能体 3 次 · 章节 1 · 图 0`。

## 8. 设置

- `routes/settings.ts`：`INKLOOM_CRITIC` 加入 `WRITABLE`，`DEFAULTS['INKLOOM_CRITIC']='on'`，写入时只允许 `on` / `off`（与 `INKLOOM_JUDGE` 同样的校验方式）。
- `SettingsPage.tsx`：`LABEL['INKLOOM_CRITIC']='任务后一致性检查'`，仿 `isJudge` 渲染 `on/off` select，说明文案「每个任务 done 前让 critic 检查一次；关闭可省 token」。
- `run-service` 读取：`(process.env['INKLOOM_CRITIC'] ?? 'on').trim() !== 'off'`。

## 9. 测试

| 文件 | 用例 |
|---|---|
| `roles.test.ts`（新增） | 四个角色齐全；白名单不含 `delegate` 与任何写工具；`toolsForRole` 只返回白名单内工具且忽略不存在的名字；`maxSteps` / `output` 与表一致 |
| `subagent.test.ts`（新增，`vi.mock('@earendil-works/pi-agent-core')`） | 正常结束返回最后一条文本并累加 tokens；子体超步数 → `terminate` 且 `ok=false`；主预算用尽 → 同样 block；`prompt` 抛错 → `ok=false` 不抛；事件严格是 `started → tool* → ended` 且 id 一致 |
| `critic.test.ts`（新增） | 纯 JSON 可解析；带 ```json 围栏可解析；坏 JSON / 缺字段 / 非法 severity → `null`；`decideCritic` 只有 error 才 blocked |
| `tools.test.ts`（补充） | `delegate` 未注入 → fail；注入 → 调用一次且返回含步数与摘要；`update_task(done)` 在 blocked 时不写 state；skipped 时写 done 且返回含「未完成」 |
| `run-service.test.ts`（补充） | `subagent.*` 事件被转发成 `AgentStreamEvent`（顺序与 id）；`INKLOOM_CRITIC=off` 时不注入 critic（用 `h.agents.length` / 工具名断言） |

## 10. 验收标准

1. 七霞真实会话里主 Agent 调 `delegate('researcher')`：对话流出现子智能体卡片，展开能看到 `web_search` 与资料卡 id。
2. 人为制造一处矛盾（如角色卡境界与正文不符）后调 `update_task(done)`：任务保持 `doing`，返回冲突与 evidence。
3. `INKLOOM_CRITIC=off` 重启后同一任务直接 `done`。
4. 子体超时或抛错时主 Agent 收到 `fail` 并能改道，run 不失败、不卡死。
5. `pnpm verify` 全绿；现有 385 单元 + 339 集成不回归。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| runner 与 `createAgentTools` 循环依赖 | runner 用 `getTools()` 惰性取工具，且只在 delegate 执行期调用 |
| `terminate` 只在整批工具结果都置位时生效 | 超限判断对批次内每次调用都成立，必然整批 terminate |
| 子体烧 token | 角色 `maxSteps` 4–6 + 主 `budget.steps` 共享 + 120s 超时；critic 可关 |
| critic 误报挡住作者 | 只有 `error` 阻断；`warning` 仅提示；evidence 缺失的条目在解析阶段就被丢弃 |
| 事件过多拖慢 SSE | 子体只发 tool 级（最多 6 条/次），不发 delta |
| 关闭开关后行为漂移 | `critic` 不注入时 `update_task` 走原路径，由现有测试保证 |

## 12. 文件清单

新增：

- `apps/api/src/agent/roles.ts` / `roles.test.ts`
- `apps/api/src/agent/subagent.ts` / `subagent.test.ts`
- `apps/api/src/agent/critic.ts` / `critic.test.ts`
- `docs/superpowers/specs/2026-10-28-multi-agent-slice3-design.md`（本文件）

修改：

- `apps/api/src/agent/tools.ts`（delegate、`AgentToolDeps`、`update_task`、`RunBudget.subagentCalls`）
- `apps/api/src/agent/tools.test.ts`
- `apps/api/src/agent/run-service.ts`（runner 组装、critic 注入、事件、tokens）
- `apps/api/src/agent/run-service.test.ts`
- `apps/api/src/routes/settings.ts`
- `apps/web/src/api/types.ts`
- `apps/web/src/pages/AgentPage.tsx`
- `apps/web/src/pages/SettingsPage.tsx`
