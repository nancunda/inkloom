# 切片 4：多智能体可用性、trace 视图与会话管理 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让共创支持「可回看、可续接的会话」，子体步数触顶不再等于失败，并把共创界面改成 AgentPrism 的 trace 形态（会话列表 / span 树 / 详情）。

**Architecture:** 后端把「会话（Session，落盘）」与「运行（Run，内存）」解耦：一个会话下多次运行，事件追加到同一个 journal，运行结束时写 meta 与 messages 快照；续接时用快照重建 Agent 并配 `transformContext` 裁剪。前端用 AgentPrism 的 `TraceList + TreeView + DetailsView` 组合（不是一体化 `TraceViewer`），把事件流映射成 `TraceSpan` 树。

**Tech Stack:** Node 24 / pnpm 11 / TypeScript strict / Biome 2 / Vitest 5 / Hono / React 19 / Tailwind 4 / Pi Agent 1.4 / AgentPrism 1.0.0（源码入库）

**Spec:** `docs/superpowers/specs/2026-10-28-multi-agent-ux-slice4-design.md`（执行时与本文一起读；两者冲突以 spec 为准）

## Global Constraints

- 命令：单测一律 `pnpm exec vitest run --project unit <file>`；**不要**用 `pnpm biome check <file>`（会变成 `biome check . <file>`），用 `pnpm exec biome check <paths>`。
- TypeScript：`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 全开；可选字段用 `...(x === undefined ? {} : { x })` 而不是 `x: undefined`。
- Biome：`noExplicitAny: error`、`noArrayIndexKey: error`、行宽 100、单引号、无分号、2 空格缩进。
- 事件类型两份同步：`apps/api/src/agent/run-service.ts` 的 `AgentStreamPayload` 必须与 `apps/web/src/api/types.ts` 的 `AgentEvent` 逐字段一致。
- 所有文件写入走 `atomicWrite` / `writeQueue`；不要直接 `writeFile`（测试夹具除外）。
- 新代码的注释用中文，写「为什么」，不写「做了什么」。
- 每个任务结束时：`pnpm exec biome check <改动路径>`、`pnpm tsc`、相关测试全绿，然后 commit。
- 测试计数以最后一次 `pnpm test` 为准，改动后更新 README 的 `pnpm verify` 注释。
- AgentPrism 源码入库后**由我们维护**：`apps/web/src/components/agent-prism/**` 排除在 biome 之外（在 `biome.json` 的 `files.includes` 加 `!apps/web/src/components/agent-prism`），但**必须过 tsc**。

---

## 文件结构（先定边界，再拆任务）

| 文件 | 职责 |
|---|---|
| `apps/api/src/agent/roles.ts` | 四角色定义 + 新增 `stepDiscipline(maxSteps)` 文案 |
| `apps/api/src/agent/subagent.ts` | 子体运行器；新增 `partial`、`text` 与步数纪律注入 |
| `apps/api/src/agent/tools.ts` | `delegate` 把「最多 N 步」写进任务、partial 返回文案 |
| `apps/api/src/agent/history.ts` | **新增**：`compactMessages`、`stripSystemMessages`、messages 快照读写 |
| `apps/api/src/agent/session-store.ts` | **新增**：`AgentSessionMeta` 读写、列会话（含 legacy 补录）、重命名、删除、读事件 |
| `apps/api/src/agent/run-service.ts` | 会话绑定、事件 `runId`、meta/快照持久化、`resumeSession` |
| `apps/api/src/routes/sessions.ts` | **新增**：六个会话接口 |
| `apps/web/src/components/agent-prism/**` | **新增**：degit 复制的上游组件（76 文件） |
| `apps/web/src/agent-trace/to-trace.ts` | **新增**：`meta + events → TraceViewerData`（纯函数） |
| `apps/web/src/agent-trace/plan-view.ts` | **新增**：从 `plan.updated` 提取任务列表 |
| `apps/web/src/agent-trace/SessionList.tsx` | **新增**：`TraceList` 封装（重命名 / 删除） |
| `apps/web/src/pages/CocreatePage.tsx` | **新增**：共创页（顶栏 / 三栏 / 门禁横幅 / 输入） |
| `apps/web/src/shell/AppShell.tsx` | `module === 'agent'` 指向 `CocreatePage` |
| `apps/web/src/pages/AgentPage.tsx` | **删除**（迁移完成后） |

依赖顺序：Task 1 → 2 → 3 → 4 → 5；Task 6 可与 1-5 并行；Task 7 依赖 6；Task 8 依赖 5 与 7；Task 9 收尾。

---

### Task 1: 子体软着陆与事件字段

**Files:**
- Modify: `apps/api/src/agent/roles.ts`
- Modify: `apps/api/src/agent/subagent.ts`
- Modify: `apps/api/src/agent/subagent.test.ts`
- Modify: `apps/api/src/agent/tools.ts`
- Modify: `apps/api/src/agent/delegate-tools.test.ts`
- Modify: `apps/api/src/agent/run-service.ts`（事件转发两处）
- Modify: `apps/web/src/api/types.ts`

**Interfaces:**
- Produces: `SubagentResult.partial: boolean`；`SubagentEvent` 的 `ended` 增加 `partial: boolean` 与 `text: string`；`stepDiscipline(maxSteps: number): string`

- [ ] **Step 1: 写失败测试（触顶有结论 → partial）**

在 `apps/api/src/agent/subagent.test.ts` 的 `describe('createSubagentRunner')` 内追加：

```ts
it('★ 步数触顶但已有结论 → ok=true + partial，不再当失败', async () => {
  h.callToolCalls = 9
  h.script = [
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '查到三条：一驿三十里' }] },
    },
  ]
  const d = deps()
  const r = await d.run({ role: 'stylist', task: 'x' })
  expect(r.ok).toBe(true)
  expect(r.partial).toBe(true)
  expect(r.error).toBe('子任务步数上限（8 步）')
  expect(r.text).toContain('一驿三十里')
  const ended = d.events.find((e) => e.type === 'ended') as Extract<SubagentEvent, { type: 'ended' }>
  expect(ended.partial).toBe(true)
  expect(ended.text).toContain('一驿三十里')
})

it('★ 触顶且没有结论 → 仍然是失败（partial=false）', async () => {
  h.callToolCalls = 9
  const d = deps()
  const r = await d.run({ role: 'stylist', task: 'x' })
  expect(r.ok).toBe(false)
  expect(r.partial).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run --project unit apps/api/src/agent/subagent.test.ts`
Expected: FAIL（`partial` 不是 `SubagentResult` 的字段 / `ended.partial` 为 undefined）

- [ ] **Step 3: 实现 partial 判定**

`apps/api/src/agent/subagent.ts`：

```ts
export interface SubagentResult {
  id: string
  role: AgentRoleId
  /** false = 一步都没跑成；true 含 partial（有结论但被上限/超时截断） */
  ok: boolean
  /** true = 结论可用但不完整（步数触顶或超时） */
  partial: boolean
  steps: number
  tokens: number
  text: string
  error: string | null
}
```

`ended` 事件加 `partial: boolean` 与 `text: string`（完整结论，已按 6000 字截断）。

收尾处替换为：

```ts
    // ★ 上限/超时截断时，已产出的结论仍然有价值：放行成 partial，别让主 Agent 白重派
    const salvaged =
      !externalStop && text.trim().length > 0 && (limitReason !== null || timedOut)
    const partial = !ok && salvaged
    const finalOk = ok || partial
    deps.onEvent({
      type: 'ended',
      id,
      role: role.id,
      ok: finalOk,
      partial,
      steps,
      tokens,
      summary: trimmed.slice(0, 400),
      text: trimmed,
      error,
    })
    return { id, role: role.id, ok: finalOk, partial, steps, tokens, text: trimmed, error }
```

（构造期异常那条 `ended` 也要补 `partial: false` 与 `text: ''`；非法 role 的早退返回补 `partial: false`。）

- [ ] **Step 4: 步数纪律注入**

`apps/api/src/agent/roles.ts` 追加并导出：

```ts
/**
 * ★ 子体不知道自己有多少预算，会在 read_url 上反复撞墙直到被强制中断。
 *   把上限和止损规则写进 systemPrompt，让它在用满前先给结论。
 */
export function stepDiscipline(maxSteps: number): string {
  return [
    '# 步数纪律',
    `你最多能调用 ${maxSteps} 次工具。每次工具失败也算一步：`,
    '- read_url 连续失败 2 次就停止读网页，改用 web_search 的摘要。',
    '- web_search 连续失败 2 次就停止检索，直接说明拿不到资料。',
    '- 步数用满前必须先给出结论：宁可结论短、带「未核实」标注，也不要空手结束。',
  ].join('\n')
}
```

`subagent.ts` 的 `new Agent` 里把 `systemPrompt` 改成：

```ts
systemPrompt: `${role.systemPrompt}\n\n${stepDiscipline(role.maxSteps)}`,
```

- [ ] **Step 5: delegate 告知步数并支持 partial 文案**

`apps/api/src/agent/tools.ts` 的 `delegateTool.execute`：

```ts
      const role = AGENT_ROLES[params.role]
      const req: SubagentRequest = {
        role: params.role,
        task: `${params.task}\n\n（本次最多 ${role.maxSteps} 步；用满前先给结论）`,
        ...(params.context === undefined ? {} : { context: params.context }),
      }
```

返回分支在「失败」之前插入：

```ts
      if (r.partial) {
        return ok(
          `【${role.label}·未跑完（${r.error ?? '中断'}）】以下结论可能不完整，需要更多信息就再派一次更窄的任务：\n${clip(r.text, 4000)}`,
          { role: r.role, steps: r.steps, tokens: r.tokens, partial: true },
        )
      }
```

- [ ] **Step 6: 同步两份事件类型与转发**

`apps/api/src/agent/run-service.ts` 的 `AgentStreamPayload` 与转发：

```ts
  | {
      type: 'subagent.ended'
      id: string
      role: AgentRoleId
      ok: boolean
      partial: boolean
      steps: number
      tokens: number
      summary: string
      text: string
      error: string | null
    }
```

转发处补 `partial: e.partial`、`text: clip(e.text, 6000)`。

`apps/web/src/api/types.ts` 的 `subagent.ended` 同步补 `partial: boolean` 与 `text: string`。

- [ ] **Step 7: 跑测试 + 类型 + 格式**

```bash
pnpm exec vitest run --project unit apps/api/src/agent/subagent.test.ts apps/api/src/agent/delegate-tools.test.ts apps/api/src/agent/roles.test.ts
pnpm exec biome check apps/api/src/agent apps/web/src/api/types.ts
pnpm tsc
```

Expected: 全绿。若 `delegate-tools.test.ts` 的 FakeSubagent 缺 `partial` 字段导致类型错，给它补 `partial: false`。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/agent apps/web/src/api/types.ts
git commit -m "feat(agent): keep partial subagent results instead of failing on step limit"
```

---

### Task 2: messages 快照与上下文裁剪

**Files:**
- Create: `apps/api/src/agent/history.ts`
- Create: `apps/api/src/agent/history.test.ts`

**Interfaces:**
- Produces:
  - `interface MessageSnapshot { version: 1; savedAt: string; sessionId: string; runId: string; messages: AgentMessage[] }`
  - `stripSystemMessages(messages: AgentMessage[]): AgentMessage[]`
  - `compactMessages(messages: AgentMessage[], opts?: { budgetChars?: number; keepRecent?: number }): AgentMessage[]`
  - `saveMessageSnapshot(root: string, sessionId: string, snap: MessageSnapshot): Promise<void>`
  - `loadMessageSnapshot(root: string, sessionId: string): Promise<MessageSnapshot | null>`
  - `messageSnapshotPath(root: string, sessionId: string): string`
- Consumes: `atomicWrite` / `readIfExists`（`../storage/atomic-write.js`）、`sessionDir`（Task 3 提供；本任务先用 `join(bookPaths(root).inkloom, 'agent', 'sessions')` 本地实现，Task 3 再改为复用）

- [ ] **Step 1: 写失败测试**

`apps/api/src/agent/history.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compactMessages,
  loadMessageSnapshot,
  saveMessageSnapshot,
  stripSystemMessages,
} from './history.js'

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 } as AgentMessage
}
function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'web_search',
    content: [{ type: 'text', text }],
    timestamp: 3,
  } as AgentMessage
}

describe('stripSystemMessages', () => {
  it('★ 丢掉所有 system：工具声明会随代码变化，不能复用旧 system', () => {
    const out = stripSystemMessages([
      { role: 'system', content: '旧提示词', timestamp: 0 } as AgentMessage,
      user('你好'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
  })
})

describe('compactMessages', () => {
  it('★ 最近 keepRecent 条原样保留', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => user(`第 ${i} 条`))
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 100_000 })
    expect(out).toHaveLength(12)
    expect(out.at(-1)).toEqual(msgs.at(-1))
  })

  it('★ 早期的 toolResult 被截断并加标注', () => {
    const long = 'x'.repeat(5000)
    const msgs = [user('目标'), toolResult(long), ...Array.from({ length: 8 }, (_, i) => user(`近 ${i}`))]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 100_000 })
    const early = out[1] as { content: { text: string }[] }
    expect(early.content[0]?.text.length).toBeLessThan(600)
    expect(early.content[0]?.text).toContain('早期工具输出已压缩')
  })

  it('★ 超出字符预算时从最旧开始丢，但保留首条 user 与最近 2 条', () => {
    const msgs = [user('原始目标'), ...Array.from({ length: 40 }, (_, i) => assistant('y'.repeat(5000)))]
    const out = compactMessages(msgs, { keepRecent: 8, budgetChars: 20_000 })
    expect((out[0] as { content: string }).content).toBe('原始目标')
    expect(out.at(-1)).toEqual(msgs.at(-1))
    expect(out.length).toBeLessThan(msgs.length)
  })
})

describe('message snapshot', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inkloom-hist-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('★ 写入后可读回，且目录自动创建', async () => {
    await saveMessageSnapshot(root, 'cs_abc', {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionId: 'cs_abc',
      runId: 'ar_1',
      messages: [user('你好')],
    })
    const back = await loadMessageSnapshot(root, 'cs_abc')
    expect(back?.messages).toHaveLength(1)
  })

  it('没有快照时返回 null', async () => {
    expect(await loadMessageSnapshot(root, 'cs_none')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run --project unit apps/api/src/agent/history.test.ts`
Expected: FAIL（`./history.js` 不存在）

- [ ] **Step 3: 实现 history.ts**

```ts
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { atomicWrite, readIfExists } from '../storage/atomic-write.js'
import { bookPaths } from '../storage/paths.js'

export interface MessageSnapshot {
  version: 1
  savedAt: string
  sessionId: string
  runId: string
  messages: AgentMessage[]
}

const DEFAULT_BUDGET = 120_000
const DEFAULT_RECENT = 8
const TOOL_CLIP = 500
const ASSISTANT_CLIP = 800

export function sessionDir(root: string): string {
  return join(bookPaths(root).inkloom, 'agent', 'sessions')
}

export function messageSnapshotPath(root: string, sessionId: string): string {
  return join(sessionDir(root), `${sessionId}.messages.json`)
}

/** ★ 首条 system 带着工具声明；工具集会随代码/开关变化，恢复时必须用当前 prompt 重建 */
export function stripSystemMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => (m as { role?: string }).role !== 'system')
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    const text = (part as { text?: string }).text
    if (typeof text === 'string') out += text
  }
  return out
}

function withText(message: AgentMessage, clipped: string, note: string): AgentMessage {
  const body = `${clipped}…${note}`
  const role = (message as { role?: string }).role
  if (role === 'toolResult' || Array.isArray((message as { content?: unknown }).content)) {
    return { ...message, content: [{ type: 'text', text: body }] } as AgentMessage
  }
  return { ...message, content: body } as AgentMessage
}

/**
 * 从新到旧扫，先按预算裁，再压缩早期工具输出。
 * ★ 保留首条 user（作者原始目标）与最后 2 条：丢了它们，续接就接不上话。
 */
export function compactMessages(
  messages: AgentMessage[],
  opts: { budgetChars?: number; keepRecent?: number } = {},
): AgentMessage[] {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET
  const keepRecent = opts.keepRecent ?? DEFAULT_RECENT
  const total = messages.reduce((n, m) => n + textOf(m).length, 0)
  const out = messages.map((m) => ({ ...m }))
  if (total <= budget) return out

  const keepFrom = Math.max(0, out.length - keepRecent)
  for (let i = 1; i < keepFrom; i += 1) {
    const m = out[i]
    if (m === undefined) continue
    const role = (m as { role?: string }).role
    if (role === 'toolResult') {
      out[i] = withText(m, textOf(m).slice(0, TOOL_CLIP), '（早期工具输出已压缩）')
    } else if (role === 'assistant') {
      out[i] = withText(m, textOf(m).slice(0, ASSISTANT_CLIP), '（早期回复已压缩）')
    }
  }

  // 压缩后仍超预算：从最旧开始丢，但保留首条与最后 2 条
  let size = out.reduce((n, m) => n + textOf(m).length, 0)
  let cursor = 1
  while (size > budget && cursor < out.length - 2) {
    const dropped = out[cursor]
    if (dropped === undefined) break
    size -= textOf(dropped).length
    out.splice(cursor, 1)
  }
  return out
}

export async function saveMessageSnapshot(
  root: string,
  sessionId: string,
  snap: MessageSnapshot,
): Promise<void> {
  const compacted = compactMessages(stripSystemMessages(snap.messages))
  const body: MessageSnapshot = { ...snap, messages: compacted }
  const text = JSON.stringify(body)
  // ★ 超大快照先压一次：>8MB 的 JSON 读起来很慢，续接时也没必要
  await atomicWrite(messageSnapshotPath(root, sessionId), `${text}\n`)
}

export async function loadMessageSnapshot(
  root: string,
  sessionId: string,
): Promise<MessageSnapshot | null> {
  const raw = await readIfExists(messageSnapshotPath(root, sessionId))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as MessageSnapshot
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}
```

（`withText` 只做「拼接截断文本 + 标注」，不负责判断是否需要截断；调用处已经 `slice` 过。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run --project unit apps/api/src/agent/history.test.ts`
Expected: PASS（6 例）

- [ ] **Step 5: 类型与格式 + Commit**

```bash
pnpm exec biome check apps/api/src/agent/history.ts apps/api/src/agent/history.test.ts
pnpm tsc
git add apps/api/src/agent/history.ts apps/api/src/agent/history.test.ts
git commit -m "feat(agent): compact and persist conversation snapshots for resuming"
```

---

### Task 3: 会话索引与存储

**Files:**
- Create: `apps/api/src/agent/session-store.ts`
- Create: `apps/api/src/agent/session-store.test.ts`

**Interfaces:**
- Consumes: `sessionDir`（Task 2 的 `history.ts` 已导出）、`agentRunDir`（`book-snapshot.ts`）
- Produces:
  - `interface AgentSessionMeta { id; title; goal; status; createdAt; updatedAt; tokens; steps; subagentCalls; planId; planTitle; planDone; planTotal; runIds; resumable }`
  - `sessionJournalPath(root, id): string`
  - `readSessionMeta(root, id)`, `writeSessionMeta(root, meta)`
  - `listSessions(root): Promise<AgentSessionMeta[]>`
  - `renameSession(root, id, title)`, `removeSession(root, id)`
  - `readSessionEvents(root, id, limit): Promise<AgentStreamEvent[]>`

- [ ] **Step 1: 写失败测试**

`apps/api/src/agent/session-store.test.ts`（要点）：

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listSessions,
  readSessionEvents,
  readSessionMeta,
  removeSession,
  renameSession,
  sessionJournalPath,
  writeSessionMeta,
} from './session-store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-sess-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function meta(id: string, title: string) {
  return {
    id,
    title,
    goal: title,
    status: 'done' as const,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    tokens: 0,
    steps: 0,
    subagentCalls: 0,
    planId: null,
    planTitle: null,
    planDone: 0,
    planTotal: 0,
    runIds: [],
    resumable: false,
  }
}

describe('session store', () => {
  it('★ 写入后可读回', async () => {
    await writeSessionMeta(root, meta('cs_a', '第一段'))
    const back = await readSessionMeta(root, 'cs_a')
    expect(back?.title).toBe('第一段')
  })

  it('★ 列表按 updatedAt 倒序', async () => {
    await writeSessionMeta(root, { ...meta('cs_old', '旧'), updatedAt: '2026-10-01T00:00:00.000Z' })
    await writeSessionMeta(root, { ...meta('cs_new', '新'), updatedAt: '2026-10-28T00:00:00.000Z' })
    const list = await listSessions(root)
    expect(list.map((s) => s.id)).toEqual(['cs_new', 'cs_old'])
  })

  it('★ 旧 runs/*.jsonl 补录成 legacy 会话（只读）', async () => {
    const runs = join(root, '.inkloom', 'agent', 'runs')
    await mkdir(runs, { recursive: true })
    await writeFile(
      join(runs, 'ar_legacy1.jsonl'),
      `${JSON.stringify({ type: 'run.started', goal: '旧目标', seq: 1, at: '2026-10-01T00:00:00.000Z' })}\n`,
      'utf8',
    )
    const list = await listSessions(root)
    const legacy = list.find((s) => s.id === 'lg_ar_legacy1')
    expect(legacy?.title).toContain('旧目标')
    expect(legacy?.resumable).toBe(false)
    expect(legacy?.status).toBe('legacy')
  })

  it('★ 回放只读 limit 条且跳过坏行', async () => {
    const file = sessionJournalPath(root, 'cs_b')
    await mkdir(join(root, '.inkloom', 'agent', 'sessions'), { recursive: true })
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'run.started', goal: 'g', seq: 1, at: '2026-10-28T00:00:00.000Z' }),
        'not json',
        JSON.stringify({ type: 'run.finished', seq: 2, at: '2026-10-28T00:00:01.000Z' }),
      ].join('\n'),
      'utf8',
    )
    const events = await readSessionEvents(root, 'cs_b', 10)
    expect(events).toHaveLength(2)
  })

  it('★ 运行中的会话不能重命名/删除', async () => {
    await writeSessionMeta(root, { ...meta('cs_run', '运行中'), status: 'running' })
    await expect(renameSession(root, 'cs_run', '新名字')).rejects.toThrow(/运行中/)
    await expect(removeSession(root, 'cs_run')).rejects.toThrow(/运行中/)
  })

  it('重命名与删除生效', async () => {
    await writeSessionMeta(root, meta('cs_c', '旧名'))
    const next = await renameSession(root, 'cs_c', '新名')
    expect(next.title).toBe('新名')
    await removeSession(root, 'cs_c')
    expect(await readSessionMeta(root, 'cs_c')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run --project unit apps/api/src/agent/session-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 session-store.ts**

```ts
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { readIfExists } from '../storage/atomic-write.js'
import { sessionDir } from './history.js'
import { agentRunDir } from './book-snapshot.js'
import type { AgentStreamEvent } from './run-service.js'
import { atomicWrite } from '../storage/atomic-write.js'

export interface AgentSessionMeta {
  id: string
  title: string
  goal: string
  status: 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped' | 'legacy'
  createdAt: string
  updatedAt: string
  tokens: number
  steps: number
  subagentCalls: number
  planId: string | null
  planTitle: string | null
  planDone: number
  planTotal: number
  runIds: string[]
  resumable: boolean
}

export function sessionJournalPath(root: string, id: string): string {
  return join(sessionDir(root), `${id}.jsonl`)
}

export function sessionMetaPath(root: string, id: string): string {
  return join(sessionDir(root), `${id}.meta.json`)
}

export function newSessionId(): string {
  return `cs_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function defaultTitle(goal: string): string {
  const one = goal.replace(/\s+/g, ' ').trim()
  return one.length <= 40 ? one : `${one.slice(0, 40)}…`
}

export async function writeSessionMeta(root: string, meta: AgentSessionMeta): Promise<void> {
  await atomicWrite(sessionMetaPath(root, meta.id), `${JSON.stringify(meta, null, 2)}\n`)
}

export async function readSessionMeta(root: string, id: string): Promise<AgentSessionMeta | null> {
  const raw = await readIfExists(sessionMetaPath(root, id))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as AgentSessionMeta
  } catch {
    return null
  }
}

function isLegacyId(id: string): boolean {
  return id.startsWith('lg_')
}

/** 旧 journal 补录成只读会话：不搬文件、不改内容，只是让它出现在列表里 */
async function legacySessions(root: string): Promise<AgentSessionMeta[]> {
  const dir = agentRunDir(root)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: AgentSessionMeta[] = []
  for (const name of names) {
    if (!name.startsWith('ar_') || !name.endsWith('.jsonl')) continue
    const runId = name.slice(0, -'.jsonl'.length)
    const events = await readSessionEventsFrom(join(dir, name), 200)
    const started = events.find((e) => e.type === 'run.started')
    const goal = started !== undefined && 'goal' in started ? String(started.goal) : runId
    const last = events.at(-1)
    out.push({
      id: `lg_${runId}`,
      title: defaultTitle(goal),
      goal,
      status: 'legacy',
      createdAt: started?.at ?? new Date().toISOString(),
      updatedAt: last?.at ?? started?.at ?? new Date().toISOString(),
      tokens: 0,
      steps: 0,
      subagentCalls: 0,
      planId: null,
      planTitle: null,
      planDone: 0,
      planTotal: 0,
      runIds: [runId],
      resumable: false,
    })
  }
  return out
}

export async function listSessions(root: string): Promise<AgentSessionMeta[]> {
  const dir = sessionDir(root)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    names = []
  }
  const own: AgentSessionMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue
    const meta = await readSessionMeta(root, name.slice(0, -'.meta.json'.length))
    if (meta !== null) own.push(meta)
  }
  const legacy = await legacySessions(root)
  return [...own, ...legacy].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function readSessionEventsFrom(file: string, limit: number): Promise<AgentStreamEvent[]> {
  const raw = await readIfExists(file)
  if (raw === null) return []
  const out: AgentStreamEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as AgentStreamEvent)
    } catch {
      // 坏行跳过：journal 是追加写的，崩溃时会留半行
    }
    if (out.length >= limit) break
  }
  return out
}

export async function readSessionEvents(
  root: string,
  id: string,
  limit: number,
): Promise<AgentStreamEvent[]> {
  const file = isLegacyId(id)
    ? join(agentRunDir(root), `${id.slice(3)}.jsonl`)
    : sessionJournalPath(root, id)
  return readSessionEventsFrom(file, limit)
}

export async function renameSession(
  root: string,
  id: string,
  title: string,
): Promise<AgentSessionMeta> {
  const meta = await readSessionMeta(root, id)
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
  if (meta.status === 'running' || meta.status === 'waiting_review') {
    throw new InkloomError('CONFLICT', '会话运行中，先停止再重命名')
  }
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new InkloomError('INVALID_INPUT', '标题不能为空')
  const next = { ...meta, title: trimmed.slice(0, 80), updatedAt: new Date().toISOString() }
  await writeSessionMeta(root, next)
  return next
}

export async function removeSession(root: string, id: string): Promise<void> {
  const meta = await readSessionMeta(root, id)
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
  if (meta.status === 'running' || meta.status === 'waiting_review') {
    throw new InkloomError('CONFLICT', '会话运行中，先停止再删除')
  }
  await rm(sessionMetaPath(root, id), { force: true })
  await rm(sessionJournalPath(root, id), { force: true })
  await rm(join(sessionDir(root), `${id}.messages.json`), { force: true })
}
```

补 `import { randomUUID } from 'node:crypto'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run --project unit apps/api/src/agent/session-store.test.ts`
Expected: PASS（6 例）

- [ ] **Step 5: 格式与 Commit**

```bash
pnpm exec biome check apps/api/src/agent/session-store.ts apps/api/src/agent/session-store.test.ts
pnpm tsc
git add apps/api/src/agent/session-store.ts apps/api/src/agent/session-store.test.ts
git commit -m "feat(agent): index sessions on disk with legacy journal fallback"
```

---

### Task 4: run-service 绑定会话

**Files:**
- Modify: `apps/api/src/agent/run-service.ts`
- Modify: `apps/api/src/agent/run-service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `loadMessageSnapshot` / `saveMessageSnapshot` / `messageSnapshotPath`；Task 3 的 `AgentSessionMeta` / `newSessionId` / `sessionJournalPath` / `writeSessionMeta`
- Produces:
  - `AgentRun.sessionId: string`
  - `AgentStreamEvent` 每条带 `runId: string`
  - `AgentRunSnapshot.sessionId: string`
  - `StartOptions = { mode?: 'new' | 'resume' | 'replan'; sessionId?: string; messages?: AgentMessage[] }`
  - `persistSessionMeta(run: AgentRun): Promise<void>`

- [ ] **Step 1: 写失败测试**

在 `apps/api/src/agent/run-service.test.ts` 追加：

```ts
it('★ 事件带 runId，快照带 sessionId', async () => {
  const started = await startAgentRun('目标', { mode: 'new' })
  expect(started.sessionId).toMatch(/^cs_/)
  const run = getAgentRun(started.id)
  expect(run?.events.every((e) => e.runId === started.id)).toBe(true)
  stopAgentRun(started.id)
})

it('★ 会话在磁盘上留下 meta 与 messages 快照', async () => {
  const started = await startAgentRun('目标', { mode: 'new' })
  const agent = lastAgent()
  agent.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
  })
  agent.emit({ type: 'agent_end' })
  agent.done()
  await vi.waitFor(async () => {
    const meta = await readSessionMeta(h.root, started.sessionId)
    expect(meta?.title).toBe('目标')
  })
  expect(await loadMessageSnapshot(h.root, started.sessionId)).not.toBeNull()
})
```

（需要 import `readSessionMeta`、`loadMessageSnapshot`，并在 `beforeEach` 清空 sessions 目录。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run --project unit apps/api/src/agent/run-service.test.ts`
Expected: FAIL（`sessionId` 不存在、`runId` 缺失）

- [ ] **Step 3: 实现会话绑定**

要点（按现有代码结构插入）：

1. `AgentRun` 接口加 `sessionId: string`。
2. `emit()`：

```ts
  const full = { ...event, seq: run.seq, at: new Date().toISOString(), runId: run.id } as AgentStreamEvent
```

3. `AgentStreamEvent` 类型：`export type AgentStreamEvent = AgentStreamPayload & { seq: number; at: string; runId: string }`。
4. `startAgentRun(goal, options)`：
   - `const sessionId = options.sessionId ?? newSessionId()`
   - `const journal = sessionJournalPath(root, sessionId)`
   - `const snapshot = options.messages === undefined ? null : options.messages`
5. `new Agent({ initialState: { ..., ...(snapshot === null ? {} : { messages: stripSystemMessages(snapshot) }) }, transformContext: compactForLlm })`
   - `transformContext: async (msgs) => compactForLlm(msgs)`，其中 `compactForLlm` 包一层 `compactMessages(stripSystemMessages(...))`
   - 注意：`transformContext` 不能丢 system（Pi 会在 `convertToLlm` 前调用）——只压缩非 system，保留 system：
   ```ts
   transformContext: async (msgs) => {
     const system = msgs.filter((m) => (m as { role?: string }).role === 'system')
     const rest = compactMessages(stripSystemMessages(msgs))
     return [...system, ...rest]
   }
   ```
6. `persistSessionMeta(run)`：

```ts
async function persistSessionMeta(run: AgentRun): Promise<void> {
  const plan = run.planId === null ? null : await loadPlan(run.root, run.planId).catch(() => null)
  const prev = await readSessionMeta(run.root, run.sessionId)
  const now = new Date().toISOString()
  const done = plan?.tasks.filter((t) => t.status === 'done').length ?? 0
  const meta: AgentSessionMeta = {
    id: run.sessionId,
    title: prev?.title ?? defaultTitle(run.goal),
    goal: run.goal,
    status: run.status,
    createdAt: prev?.createdAt ?? run.startedAt,
    updatedAt: now,
    tokens: run.tokens,
    steps: run.budget.steps,
    subagentCalls: run.budget.subagentCalls,
    planId: run.planId,
    planTitle: plan?.title ?? null,
    planDone: done,
    planTotal: plan?.tasks.length ?? 0,
    runIds: [...new Set([...(prev?.runIds ?? []), run.id])],
    resumable: run.status !== 'running' && run.status !== 'waiting_review',
  }
  await writeSessionMeta(run.root, meta)
  await saveMessageSnapshot(run.root, run.sessionId, {
    version: 1,
    savedAt: now,
    sessionId: run.sessionId,
    runId: run.id,
    messages: run.agent.messages,
  })
}
```

7. 在 `run.finished / paused / failed / stopped` 与 `stopAgentRun` 的收尾调用 `void persistSessionMeta(run)`（用 `writeQueue` 包一层，避免并发覆盖）。
8. `snapshot()` 加 `sessionId`。

- [ ] **Step 4: 跑测试 + tsc**

```bash
pnpm exec vitest run --project unit apps/api/src/agent/run-service.test.ts
pnpm tsc
```

Expected: PASS。若前端 `AgentRun` 类型（`apps/web/src/api/types.ts`）缺 `sessionId` 导致 tsc 报错，同步加上。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/run-service.ts apps/api/src/agent/run-service.test.ts apps/web/src/api/types.ts
git commit -m "feat(agent): bind runs to durable sessions and persist snapshots"
```

---

### Task 5: 会话接口与真续接

**Files:**
- Create: `apps/api/src/routes/sessions.ts`
- Modify: `apps/api/src/agent/run-service.ts`（`startSession` / `resumeSession`）
- Modify: `apps/api/src/routes/index.ts`（或挂载路由的文件）
- Create: `apps/api/src/routes/sessions.int.test.ts`

**Interfaces:**
- Consumes: Task 2 `loadMessageSnapshot`；Task 3 `readSessionMeta` / `listSessions` / `renameSession` / `removeSession` / `readSessionEvents`；Task 4 `startAgentRun(goal, { sessionId, messages })`
- Produces:
  - `startSession(goal: string, mode: 'new' | 'resume' | 'replan'): Promise<{ run: AgentRunSnapshot; meta: AgentSessionMeta }>`
  - `resumeSession(sessionId: string, text: string): Promise<AgentRunSnapshot>`
  - 六条 HTTP 路由（见 spec §9）

- [ ] **Step 1: 写失败测试（集成）**

`apps/api/src/routes/sessions.int.test.ts`：用现有 integration 测试的建书夹具（参考 `apps/api/src/routes/agent.int.test.ts` 的写法），覆盖：

```ts
it('★ 新建会话 → 列表可见 → 回放有事件', async () => {
  const created = await api('POST', '/api/agent/sessions', { goal: '写一个开头', mode: 'new' })
  expect(created.status).toBe(200)
  const id = created.body.meta.id as string

  const list = await api('GET', '/api/agent/sessions')
  expect(list.body.sessions.some((s: { id: string }) => s.id === id)).toBe(true)

  const detail = await api('GET', `/api/agent/sessions/${id}`)
  expect(detail.body.events.some((e: { type: string }) => e.type === 'run.started')).toBe(true)
})

it('★ 运行中的会话不能删除（409）', async () => {
  const created = await api('POST', '/api/agent/sessions', { goal: 'x', mode: 'new' })
  const id = created.body.meta.id as string
  const res = await api('DELETE', `/api/agent/sessions/${id}`)
  expect(res.status).toBe(409)
})

it('★ 没有 messages 快照时续接返回 409', async () => {
  const res = await api('POST', '/api/agent/sessions/cs_missing/messages', { text: '继续' })
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run --project integration apps/api/src/routes/sessions.int.test.ts`
Expected: FAIL（路由 404）

- [ ] **Step 3: 实现 run-service 的两个入口**

```ts
export async function startSession(
  goal: string,
  mode: 'new' | 'resume' | 'replan' = 'new',
): Promise<{ run: AgentRunSnapshot; meta: AgentSessionMeta }> {
  const snapshotRun = await startAgentRun(goal, { mode })
  // ★ snapshot 里没有内存态，meta 要从 live run 生成；刚创建时 meta 可能还没落盘
  const live = getAgentRun(snapshotRun.id)
  const meta = live === null ? null : await ensureSessionMeta(live)
  if (meta === null) throw new InkloomError('INTERNAL', '会话元信息创建失败')
  return { run: snapshotRun, meta }
}

export async function resumeSession(sessionId: string, text: string): Promise<AgentRunSnapshot> {
  const { root } = getContext()
  if (hasLiveAgentRun()) {
    throw new InkloomError('CONFLICT', '还有进行中的会话，先停止再继续别的会话')
  }
  const meta = await readSessionMeta(root, sessionId)
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${sessionId} 不存在`)
  if (meta.status === 'legacy') throw new InkloomError('CONFLICT', '历史记录只读，不能续接')
  const snapshot = await loadMessageSnapshot(root, sessionId)
  if (snapshot === null) {
    throw new InkloomError('CONFLICT', '这个会话没有可续接的记录（消息快照缺失）')
  }
  const run = await startAgentRun(meta.goal, {
    mode: 'resume',
    sessionId,
    messages: snapshot.messages,
  })
  return sendAgentMessage(run.id, text)
}
```

`ensureSessionMeta(run)`：按 Task 4 的 `persistSessionMeta` 逻辑抽出，返回 meta 而不只是写盘（`persistSessionMeta` 改为调用它并 `writeSessionMeta`）。

- [ ] **Step 4: 实现路由**

`apps/api/src/routes/sessions.ts`：

```ts
import { Hono } from 'hono'
import { InkloomError } from '@inkloom/shared'
import { getContext } from '../services/context.js'
import { startSession, resumeSession } from '../agent/run-service.js'
import {
  listSessions,
  readSessionEvents,
  readSessionMeta,
  removeSession,
  renameSession,
} from '../agent/session-store.js'

export const sessionRoutes = new Hono()

sessionRoutes.get('/agent/sessions', async (c) => {
  const { root } = getContext()
  const limit = Number(c.req.query('limit') ?? '50')
  const sessions = (await listSessions(root)).slice(0, Number.isFinite(limit) ? limit : 50)
  return c.json({ sessions })
})

sessionRoutes.get('/agent/sessions/:id', async (c) => {
  const { root } = getContext()
  const id = c.req.param('id')
  const meta = await readSessionMeta(root, id)
  if (meta === null) {
    // legacy 会话的 meta 是即时生成的，回放仍要能拿到
    const legacy = (await listSessions(root)).find((s) => s.id === id)
    if (legacy === undefined) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
    const limit = Number(c.req.query('limit') ?? '2000')
    return c.json({ meta: legacy, events: await readSessionEvents(root, id, limit) })
  }
  const limit = Number(c.req.query('limit') ?? '2000')
  return c.json({ meta, events: await readSessionEvents(root, id, limit) })
})

sessionRoutes.patch('/agent/sessions/:id', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null
  if (typeof body?.title !== 'string') {
    throw new InkloomError('INVALID_INPUT', 'title 必须是字符串')
  }
  const { root } = getContext()
  return c.json({ meta: await renameSession(root, c.req.param('id'), body.title) })
})

sessionRoutes.delete('/agent/sessions/:id', async (c) => {
  const { root } = getContext()
  await removeSession(root, c.req.param('id'))
  return c.json({ ok: true })
})

sessionRoutes.post('/agent/sessions', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { goal?: unknown; mode?: unknown } | null
  const goal = typeof body?.goal === 'string' && body.goal.trim().length > 0 ? body.goal.trim() : null
  if (goal === null) throw new InkloomError('INVALID_INPUT', 'goal 不能为空')
  const mode = body?.mode === 'resume' || body?.mode === 'replan' ? body.mode : 'new'
  return c.json(await startSession(goal, mode))
})

sessionRoutes.post('/agent/sessions/:id/messages', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text.length === 0) throw new InkloomError('INVALID_INPUT', '消息不能为空')
  return c.json({ run: await resumeSession(c.req.param('id'), text) })
})
```

在路由汇总处挂载（找到 `agentRoutes` 的注册位置，追加 `sessionRoutes`）。

- [ ] **Step 5: 跑测试 + 类型**

```bash
pnpm exec vitest run --project integration apps/api/src/routes/sessions.int.test.ts
pnpm tsc
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes apps/api/src/agent/run-service.ts
git commit -m "feat(api): expose session list, replay, rename, delete and resume"
```

---

### Task 6: AgentPrism 源码引入与 Tailwind 4 适配

**Files:**
- Create: `apps/web/src/components/agent-prism/**`（degit 复制 76 文件）
- Create: `apps/web/src/components/agent-prism/NOTICE.md`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/index.css`
- Modify: `biome.json`（排除上游源码）

**Interfaces:**
- Produces: 可从 `../components/agent-prism/TraceList/TraceList`、`.../TreeView`、`.../DetailsView/DetailsView` 导入组件
- Consumes: `.tmp-spike/agent-prism`（spike 已拉取；若不存在，重新执行 Step 1）

- [ ] **Step 1: 复制源码**

```powershell
# 若 .tmp-spike/agent-prism 不存在：
npx --yes degit evilmartians/agent-prism/packages/ui/src/components .tmp-spike/agent-prism
# 复制进项目（保留目录结构；-Force 包含隐藏文件）
New-Item -ItemType Directory -Force apps/web/src/components/agent-prism | Out-Null
Get-ChildItem -Force .tmp-spike/agent-prism | Copy-Item -Destination apps/web/src/components/agent-prism -Recurse -Force
```

记录上游 commit：

```powershell
(git ls-remote https://github.com/evilmartians/agent-prism HEAD) -split "`t" | Select-Object -First 1
```

- [ ] **Step 2: 安装依赖**

```bash
pnpm --filter @inkloom/web add @evilmartians/agent-prism-types@1.0.0 @evilmartians/agent-prism-data@1.0.0 @radix-ui/react-collapsible @radix-ui/react-tabs classnames lucide-react react-json-pretty react-resizable-panels
```

- [ ] **Step 3: 写 NOTICE.md**

```md
# AgentPrism（已复制源码）

- 上游：https://github.com/evilmartians/agent-prism
- 复制时 commit：<Step 1 的输出>
- 许可证：MIT（见上游仓库）
- 复制日期：2026-10-28

## 我们对上游做的改动（升级时按此清单重放）

1. Tailwind 3 → 4 主题适配：`apps/web/src/index.css` 里用 `@theme inline` 映射 `--agentprism-*`
2. `rounded-sm` → `rounded-xs`（2 处）
3. `shadow-sm` → `shadow-xs`（1 处）
4. `outline-none` → `outline-hidden`（1 处）
5. `DetailsView` 增加 `extraTabs` 支持（切片 4）
6. `TraceList` 增加可选 `onRename` / `onDelete`（切片 4）

## 维护约定

- 不跟随上游自动升级；需要升级时重新 degit，并按上面清单重放改动。
- 本目录排除在 Biome 之外（上游风格不同），但必须通过 `tsc`。
```

- [ ] **Step 4: Tailwind 4 主题映射**

`apps/web/src/index.css` 顶部追加（放在现有 `@import "tailwindcss"` 之后）：

```css
@import "./components/agent-prism/theme/theme.css";

@theme inline {
  --color-agentprism-background: oklch(var(--agentprism-background));
  --color-agentprism-foreground: oklch(var(--agentprism-foreground));
  --color-agentprism-primary: oklch(var(--agentprism-primary));
  --color-agentprism-primary-foreground: oklch(var(--agentprism-primary-foreground));
  --color-agentprism-secondary: oklch(var(--agentprism-secondary));
  --color-agentprism-secondary-foreground: oklch(var(--agentprism-secondary-foreground));
  --color-agentprism-muted: oklch(var(--agentprism-muted));
  --color-agentprism-muted-foreground: oklch(var(--agentprism-muted-foreground));
  --color-agentprism-accent: oklch(var(--agentprism-accent));
  --color-agentprism-accent-foreground: oklch(var(--agentprism-accent-foreground));
  --color-agentprism-brand: oklch(var(--agentprism-brand));
  --color-agentprism-brand-foreground: oklch(var(--agentprism-brand-foreground));
  --color-agentprism-brand-secondary: oklch(var(--agentprism-brand-secondary));
  --color-agentprism-brand-secondary-foreground: oklch(var(--agentprism-brand-secondary-foreground));
  --color-agentprism-border: oklch(var(--agentprism-border));
  --color-agentprism-border-subtle: oklch(var(--agentprism-border-subtle));
  --color-agentprism-border-strong: oklch(var(--agentprism-border-strong));
  --color-agentprism-border-inverse: oklch(var(--agentprism-border-inverse));
  --color-agentprism-success: oklch(var(--agentprism-success));
  --color-agentprism-success-muted: oklch(var(--agentprism-success-muted));
  --color-agentprism-success-muted-foreground: oklch(var(--agentprism-success-muted-foreground));
  --color-agentprism-error: oklch(var(--agentprism-error));
  --color-agentprism-error-muted: oklch(var(--agentprism-error-muted));
  --color-agentprism-error-muted-foreground: oklch(var(--agentprism-error-muted-foreground));
  --color-agentprism-warning: oklch(var(--agentprism-warning));
  --color-agentprism-warning-muted: oklch(var(--agentprism-warning-muted));
  --color-agentprism-warning-muted-foreground: oklch(var(--agentprism-warning-muted-foreground));
}
```

先对照 `theme/index.ts` 的 `AGENT_PRISM_TOKENS` 数组补全剩余 token（缺一个就会有一类元素没颜色）。

- [ ] **Step 5: 4 处类名调整**

```powershell
# 找出确切位置
Get-ChildItem -Recurse -Filter *.tsx apps/web/src/components/agent-prism | Select-String -Pattern "rounded-sm|shadow-sm|outline-none"
```

按 NOTICE 的清单替换（`rounded-sm→rounded-xs`、`shadow-sm→shadow-xs`、`outline-none→outline-hidden`）。

- [ ] **Step 6: Biome 排除 + tsc 修错**

`biome.json` 的 `files.includes` 加一条：

```json
"!apps/web/src/components/agent-prism"
```

然后：

```bash
pnpm tsc
```

Expected: 可能报若干错误（strict + exactOptionalPropertyTypes）。逐个修：可选属性用 `...(x === undefined ? {} : { x })`，索引访问加 `?.`，禁止 `any` 改为具体类型。**不要**在 tsconfig 里 exclude 这个目录——它必须参与类型检查。

- [ ] **Step 7: 构建验证**

```bash
pnpm --filter @inkloom/web build
```

Expected: 成功。若 Tailwind 报未知类（`bg-agentprism-*`），说明 `@theme inline` 的 token 有遗漏，回到 Step 4 补齐。

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/index.css biome.json apps/web/src/components/agent-prism
git commit -m "feat(web): vendor agent-prism components with tailwind 4 theme"
```

---

### Task 7: TraceSpan 映射与组件微调

**Files:**
- Create: `apps/web/src/agent-trace/to-trace.ts`
- Create: `apps/web/src/agent-trace/to-trace.test.ts`
- Create: `apps/web/src/agent-trace/plan-view.ts`
- Create: `apps/web/src/agent-trace/plan-view.test.ts`
- Create: `apps/web/src/agent-trace/SessionList.tsx`
- Modify: `apps/web/src/components/agent-prism/DetailsView/DetailsView.tsx`（`extraTabs`）
- Modify: `apps/web/src/components/agent-prism/TraceList/TraceList.tsx`（`onRename` / `onDelete`）

**Interfaces:**
- Consumes: `AgentSessionMeta`、`AgentEvent`（`apps/web/src/api/types.ts`）、`TraceRecord` / `TraceSpan`（`@evilmartians/agent-prism-types`）
- Produces:
  - `toTraceData(meta: AgentSessionMeta, events: AgentEvent[]): { traceRecord: TraceRecord; spans: TraceSpan[] }`
  - `planTasksFrom(events: AgentEvent[]): { id; title; status; artifacts }[]`
  - `SessionList(props)`（封装 `TraceList`）

- [ ] **Step 1: 写失败测试**

`apps/web/src/agent-trace/to-trace.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../api/types'
import { toTraceData } from './to-trace'

function ev(partial: Record<string, unknown>): AgentEvent {
  return { seq: 1, at: '2026-10-28T10:00:00.000Z', runId: 'ar_1', ...partial } as unknown as AgentEvent
}

const meta = {
  id: 'cs_1',
  title: '测试会话',
  goal: '写开头',
  status: 'done' as const,
  createdAt: '2026-10-28T09:59:00.000Z',
  updatedAt: '2026-10-28T10:05:00.000Z',
  tokens: 1200,
  steps: 9,
  subagentCalls: 1,
  planId: null,
  planTitle: null,
  planDone: 0,
  planTotal: 0,
  runIds: ['ar_1'],
  resumable: true,
}

describe('toTraceData', () => {
  it('★ run.started 成为根 span，user.message 成为作者 span', () => {
    const { traceRecord, spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: '写开头' }),
      ev({ type: 'user.message', text: '先派研究员' }),
    ])
    expect(traceRecord.id).toBe('cs_1')
    expect(spans).toHaveLength(1)
    expect(spans[0]?.type).toBe('agent_invocation')
    expect(spans[0]?.children?.some((c) => c.title.includes('作者'))).toBe(true)
  })

  it('★ 工具配对：started/ended 合成一个 timer，error 状态透传', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'tool.started', toolCallId: 't1', toolName: 'web_search', args: { query: '唐' } }),
      ev({ type: 'tool.ended', toolCallId: 't1', toolName: 'web_search', isError: true, summary: '超时' }),
    ])
    const tool = spans[0]?.children?.find((c) => c.title.includes('联网搜索'))
    expect(tool?.type).toBe('tool_execution')
    expect(tool?.status).toBe('error')
    expect(tool?.output).toBe('超时')
  })

  it('★ 子体 partial → warning，output 用完整 text', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'subagent.started', id: 'sa_1', role: 'researcher', task: '查驿站' }),
      ev({ type: 'subagent.tool', id: 'sa_1', role: 'researcher', toolCallId: 's1', toolName: 'web_search', ok: true, summary: '6 条', steps: 1 }),
      ev({ type: 'subagent.ended', id: 'sa_1', role: 'researcher', ok: true, partial: true, steps: 8, tokens: 900, summary: '摘要', text: '完整结论内容', error: '步数上限（8 步）' }),
    ])
    const sub = spans[0]?.children?.find((c) => c.title.includes('研究员'))
    expect(sub?.status).toBe('warning')
    expect(sub?.output).toBe('完整结论内容')
    expect(sub?.children).toHaveLength(1)
  })

  it('★ 第二个 run.started 变成「继续对话」事件，不新建根 span', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'run.finished', runId: 'ar_1', seq: 2 }),
      ev({ type: 'run.started', goal: '继续', runId: 'ar_2', seq: 1 }),
    ])
    expect(spans).toHaveLength(1)
    expect(spans[0]?.children?.some((c) => c.title.includes('继续对话'))).toBe(true)
  })

  it('★ 未知事件落到 span 兜底，不丢信息', () => {
    const { spans } = toTraceData(meta, [
      ev({ type: 'run.started', goal: 'g' }),
      ev({ type: 'something.new', foo: 1 }),
    ])
    const child = spans[0]?.children?.find((c) => c.type === 'span')
    expect(child?.raw[0]).toContain('something.new')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run --project unit apps/web/src/agent-trace/to-trace.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 to-trace.ts**

结构（关键逻辑，完整实现按此展开）：

```ts
import type { TraceRecord, TraceSpan } from '@evilmartians/agent-prism-types'
import type { AgentEvent, AgentSessionMeta } from '../api/types'

const ROLE_LABEL: Record<string, string> = {
  researcher: '研究员',
  worldbuilder: '世界建筑师',
  critic: '一致性检查员',
  stylist: '文风顾问',
}

const TOOL_LABEL: Record<string, string> = {
  read_book: '读取全书',
  read_element: '读取要素',
  web_search: '联网搜索',
  read_url: '读网页',
  read_lore: '读资料卡',
  query_graph: '查图谱',
  find_path: '查路径',
  explain_fact: '解释关系',
  write_element: '写入要素',
  write_blueprint: '写入蓝图',
  write_plan: '写计划',
  update_plan: '改计划',
  update_task: '更新任务',
  request_review: '请求审阅',
  generate_chapter: '生成章节',
  generate_portrait: '生成形象图',
  delegate: '派子智能体',
}

function spanOf(
  id: string,
  title: string,
  type: TraceSpan['type'],
  start: string,
  end: string,
  status: TraceSpan['status'] = 'success',
): TraceSpan {
  return {
    id,
    title,
    type,
    status,
    startTime: new Date(start),
    endTime: new Date(end),
    raw: [],
  }
}

export function toTraceData(
  meta: AgentSessionMeta,
  events: AgentEvent[],
): { traceRecord: TraceRecord; spans: TraceSpan[] } {
  const sp = events.filter((e) => e.type === 'run.started')
  const first = sp[0]
  const last = events.at(-1)
  const started = new Date(first?.at ?? meta.createdAt).getTime()
  const ended = new Date(last?.at ?? meta.updatedAt).getTime()

  const traceRecord: TraceRecord = {
    id: meta.id,
    name: meta.title,
    spansCount: events.length,
    durationMs: Math.max(0, ended - started),
    agentDescription: `${meta.status} · ${meta.steps} 步 · ${meta.subagentCalls} 次子智能体`,
    startTime: started,
    totalTokens: meta.tokens,
  }

  const root = spanOf(
    'root',
    `主笔 · ${meta.goal.slice(0, 20)}`,
    'agent_invocation',
    first?.at ?? meta.createdAt,
    last?.at ?? meta.updatedAt,
    meta.status === 'failed' ? 'error' : meta.status === 'paused' ? 'warning' : 'success',
  )
  root.output = meta.title
  const children: TraceSpan[] = []
  root.children = children

  // 事件 → span 的游标（同一 toolCallId 的 started/ended 配对；子体按 id 归并）
  const openTools = new Map<string, TraceSpan>()
  const openSubagents = new Map<string, TraceSpan>()
  let runCount = 0
  let llm: TraceSpan | null = null

  for (const e of events) {
    const at = e.at
    switch (e.type) {
      case 'run.started': {
        runCount += 1
        if (runCount > 1) {
          const cont = spanOf(`cont:${e.runId}`, '继续对话', 'event', at, at)
          cont.output = e.goal
          cont.raw = [JSON.stringify(e)]
          children.push(cont)
        }
        break
      }
      case 'user.message': {
        const s = spanOf(`u:${e.seq}`, '作者', 'chain_operation', at, at)
        s.output = e.text
        s.raw = [JSON.stringify(e)]
        children.push(s)
        llm = null
        break
      }
      case 'thinking.delta':
      case 'text.delta': {
        if (llm === null) {
          llm = spanOf(`llm:${e.seq}`, '模型', 'llm_call', at, at)
          llm.reasoning = { content: '' }
          llm.output = ''
          children.push(llm)
        }
        llm.endTime = new Date(at)
        if (e.type === 'thinking.delta') {
          llm.reasoning = { content: `${llm.reasoning?.content ?? ''}${e.text}` }
        } else {
          llm.output = `${llm.output ?? ''}${e.text}`
        }
        break
      }
      case 'tool.started': {
        const s = spanOf(`t:${e.toolCallId}`, TOOL_LABEL[e.toolName] ?? e.toolName, 'tool_execution', at, at, 'pending')
        s.input = JSON.stringify(e.args)
        s.raw = [JSON.stringify(e)]
        children.push(s)
        openTools.set(e.toolCallId, s)
        break
      }
      case 'tool.ended': {
        const s = openTools.get(e.toolCallId)
        if (s !== undefined) {
          s.status = e.isError ? 'error' : 'success'
          s.output = e.summary
          s.endTime = new Date(at)
        }
        break
      }
      case 'subagent.started': {
        const s = spanOf(`sa:${e.id}`, `${ROLE_LABEL[e.role] ?? e.role}`, 'agent_invocation', at, at, 'pending')
        s.input = e.task
        s.raw = [JSON.stringify(e)]
        s.children = []
        children.push(s)
        openSubagents.set(e.id, s)
        break
      }
      case 'subagent.tool': {
        const parent = openSubagents.get(e.id)
        if (parent !== undefined) {
          const s = spanOf(`sat:${e.toolCallId}`, TOOL_LABEL[e.toolName] ?? e.toolName, 'tool_execution', at, at, e.ok ? 'success' : 'error')
          s.output = e.summary
          parent.children?.push(s)
        }
        break
      }
      case 'subagent.ended': {
        const s = openSubagents.get(e.id)
        if (s !== undefined) {
          s.status = !e.ok ? 'error' : e.partial ? 'warning' : 'success'
          s.output = e.text.length > 0 ? e.text : e.summary
          s.endTime = new Date(at)
          s.tokenUsage = { total: { tokens: e.tokens } }
        }
        break
      }
      case 'plan.updated': {
        const s = spanOf(`plan:${e.plan.id}`, `计划《${e.plan.title}》`, 'chain_operation', at, at)
        s.children = e.plan.tasks.map((t) =>
          spanOf(`task:${t.id}`, `${t.title}`, 'span', at, at, t.status === 'done' ? 'success' : t.status === 'blocked' ? 'error' : 'pending'),
        )
        s.raw = [JSON.stringify(e)]
        children.push(s)
        break
      }
      case 'gate.waiting': {
        const s = spanOf(`gate:${e.seq}`, e.gate.kind === 'plan' ? '等待批准计划' : '等待审阅任务', 'event', at, at, 'warning')
        s.output = e.gate.title ?? ''
        children.push(s)
        break
      }
      case 'gate.resolved': {
        const s = spanOf(`gate-done:${e.seq}`, e.decision === 'approve' ? '已批准' : e.decision === 'revise' ? '已打回' : '已跳过', 'event', at, at, 'success')
        s.output = e.feedback ?? ''
        children.push(s)
        break
      }
      default: {
        const s = spanOf(`ev:${e.runId}:${e.seq}`, e.type, 'span', at, at)
        s.raw = [JSON.stringify(e)]
        children.push(s)
      }
    }
  }

  return { traceRecord, spans: [root] }
}
```

（`AgentEvent` 的窄化在 `switch` 上依赖判别字段 `type`；若 TS 报 `e.plan` 不存在，检查 web 的 `AgentEvent` 是否已包含 `plan.updated` 的字段。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run --project unit apps/web/src/agent-trace/to-trace.test.ts`
Expected: PASS（5 例）

- [ ] **Step 5: plan-view.ts + 测试**

```ts
import type { AgentEvent, AgentPlanTask } from '../api/types'

/** 从事件流取最新一次 plan.updated 的任务列表（供「计划」tab） */
export function planTasksFrom(events: AgentEvent[]): AgentPlanTask[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e !== undefined && e.type === 'plan.updated') return e.plan.tasks
  }
  return []
}
```

测试：空事件 → `[]`；两次 plan.updated → 取后者。

- [ ] **Step 6: 组件微调**

`DetailsView.tsx` 增加：

```ts
export type DetailsViewExtraTab = { key: string; title: string; content: ReactNode }
// props 增加
extraTabs?: DetailsViewExtraTab[] | undefined
```

渲染处把 `extraTabs` 映射成 `TabItem`，插在 Raw 之前（找到现有的 tabs 数组拼接处）。

`TraceList.tsx` 增加可选回调：

```ts
onRename?: ((trace: TraceRecord) => void) | undefined
onDelete?: ((trace: TraceRecord) => void) | undefined
```

在每行右侧加一个 `…` 菜单（用原生 `<button>` + 简单的绝对定位菜单即可，避免引入新依赖）。

- [ ] **Step 7: SessionList.tsx**

```tsx
import type { TraceRecord } from '@evilmartians/agent-prism-types'
import { TraceList } from '../components/agent-prism/TraceList/TraceList'

export function SessionList(props: {
  traces: TraceRecord[]
  selected?: TraceRecord
  onSelect: (trace: TraceRecord) => void
  onRename: (trace: TraceRecord) => void
  onDelete: (trace: TraceRecord) => void
}): React.ReactElement {
  return (
    <TraceList
      traces={props.traces}
      expanded
      onExpandStateChange={() => undefined}
      onTraceSelect={props.onSelect}
      selectedTrace={props.selected}
      onRename={props.onRename}
      onDelete={props.onDelete}
    />
  )
}
```

- [ ] **Step 8: 测试 + 构建 + Commit**

```bash
pnpm exec vitest run --project unit apps/web/src/agent-trace
pnpm tsc
pnpm --filter @inkloom/web build
git add apps/web/src/agent-trace apps/web/src/components/agent-prism
git commit -m "feat(web): map agent events into trace spans"
```

---

### Task 8: 共创页重构（CocreatePage）

**Files:**
- Create: `apps/web/src/pages/CocreatePage.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx`
- Modify: `apps/web/src/api/types.ts`（补 `runId`、`sessionId`、`partial`、`text`、`AgentSessionMeta`）
- Delete: `apps/web/src/pages/AgentPage.tsx`

**Interfaces:**
- Consumes: `SessionList`、`TreeView`、`DetailsView`（含 `extraTabs`）、`toTraceData`、`planTasksFrom`、现有 `api` / `post` 客户端
- Produces: 共创 module 的新页面

- [ ] **Step 1: 补前端类型**

`apps/web/src/api/types.ts`：

```ts
export type AgentSessionStatus =
  | 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped' | 'legacy'

export interface AgentSessionMeta {
  id: string
  title: string
  goal: string
  status: AgentSessionStatus
  createdAt: string
  updatedAt: string
  tokens: number
  steps: number
  subagentCalls: number
  planId: string | null
  planTitle: string | null
  planDone: number
  planTotal: number
  runIds: string[]
  resumable: boolean
}
```

`AgentEvent` 每条加 `runId: string`；`subagent.ended` 补 `partial: boolean`、`text: string`；`AgentRun` 补 `sessionId: string`。

- [ ] **Step 2: 页面骨架**

`CocreatePage.tsx` 状态与数据流：

```tsx
const [sessions, setSessions] = useState<AgentSessionMeta[]>([])
const [selectedId, setSelectedId] = useState<string | null>(null)
const [meta, setMeta] = useState<AgentSessionMeta | null>(null)
const [events, setEvents] = useState<AgentEvent[]>([])
const [selectedSpan, setSelectedSpan] = useState<TraceSpan | undefined>()
const [expandedSpansIds, setExpandedSpansIds] = useState<string[]>([])
const [run, setRun] = useState<AgentRun | null>(null)
const [draft, setDraft] = useState('')
const [gate, setGate] = useState<AgentGate | null>(null)
const [error, setError] = useState<string | null>(null)
const seen = useRef<Set<string>>(new Set())
```

- 挂载：`GET /agent/sessions` → `setSessions`；有运行中的会话则自动选中它
- 选中会话：`GET /agent/sessions/:id?limit=2000` → `setMeta` / `setEvents`（重置 `seen`）
- 派生：`const { traceRecord, spans } = useMemo(() => (meta === null ? null : toTraceData(meta, events)), [meta, events])`；为 null 时只渲染空态（biome 禁 `noNonNullAssertion`，不能用 `meta!`）
- `traces`：`sessions.map(toTraceRecordLite)`（只填 `TraceRecord` 必填字段，`spans` 不预载）

- [ ] **Step 3: SSE 增量**

```tsx
useEffect(() => {
  if (run === null) return
  if (run.status !== 'running' && run.status !== 'waiting_review') return
  const es = new EventSource(`/api/agent/runs/${run.id}/events`)
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data) as AgentEvent
    if (ev.type === 'ping') return
    const key = `${ev.runId}:${ev.seq}`
    if (seen.current.has(key)) return
    seen.current.add(key)
    setEvents((prev) => [...prev, ev])
    if (ev.type === 'gate.waiting') setGate(ev.gate)
    if (ev.type === 'gate.resolved') setGate(null)
    if (ev.type === 'run.finished' || ev.type === 'run.paused' || ev.type === 'run.failed' || ev.type === 'run.stopped') {
      void api<{ run: AgentRun }>(`/agent/runs/${run.id}`).then(({ run: next }) => setRun(next)).catch(() => undefined)
      void refreshSessions()
    }
  }
  es.onerror = () => setError('连接断开，正在重连')
  return () => es.close()
}, [run?.id, run?.status])
```

- [ ] **Step 4: 布局**

```tsx
<div className="flex h-full min-h-0 flex-col">
  {/* 顶栏 */}
  <header className="flex items-center gap-3 border-b px-4 py-2 text-[12px]">
    <input value={meta?.title ?? ''} onBlur={rename} className="min-w-0 flex-1 bg-transparent" />
    <span>{STATUS_LABEL[meta?.status ?? 'done']}</span>
    <span>步数 {meta?.steps}/{run?.budget.maxSteps ?? '—'} · 子智能体 {meta?.subagentCalls ?? 0}</span>
    <button onClick={startNew}>新会话</button>
    {run?.status === 'running' && <button onClick={stop}>停止</button>}
    {(run?.status === 'paused' || run?.status === 'stopped' || run?.status === 'failed') && (
      <button onClick={resumeRun}>继续执行</button>
    )}
  </header>
  {gate !== null && <GateBanner gate={gate} onDecide={decide} />}
  <div className="flex min-h-0 flex-1">
    <aside className="w-64 shrink-0 overflow-auto border-r">
      <SessionList traces={traces} {...(traceRecord === null ? {} : { selected: traceRecord })} onSelect={select} onRename={renameTrace} onDelete={deleteSession} />
    </aside>
    <section className="min-w-0 flex-1 overflow-auto">
      <TreeView spans={spans} onSpanSelect={setSelectedSpan} selectedSpan={selectedSpan}
        expandedSpansIds={expandedSpansIds} onExpandSpansIdsChange={setExpandedSpansIds}
        spanCardViewOptions={{ expandButton: 'inside' }} />
    </section>
    <aside className="w-[420px] shrink-0 overflow-auto border-l">
      {selectedSpan !== undefined && (
        <DetailsView data={selectedSpan} allSpans={spans} extraTabs={[
          { key: 'plan', title: '计划', content: <PlanTab tasks={planTasks} /> },
          { key: 'chapter', title: '正文', content: <ChapterTab chapterNo={1} /> },
        ]} />
      )}
    </aside>
  </div>
  <footer className="border-t p-3">
    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
    <button onClick={send} disabled={!canSend}>{canSendLabel}</button>
  </footer>
</div>
```

- 发送逻辑：
  - 会话在运行 → `POST /agent/runs/:id/messages`（steer）
  - `waiting_review` → `POST /agent/runs/:id/review`（decision=revise, feedback=text）
  - 历史会话可续接 → `POST /agent/sessions/:id/messages`
  - 没有会话 → `POST /agent/sessions`（新会话）
- `GateBanner`：`gate.kind === 'plan'` → 批准 / 打回（textarea 反馈）；`task` → 通过 / 打回 / 跳过

- [ ] **Step 5: 计划与正文 tab**

- `PlanTab`：`planTasksFrom(events)` 渲染任务列表（状态色与 `TASK_TONE` 同理）+ 每个任务的产物路径
- `ChapterTab`：`GET /chapters/1`（现有接口，参考 AgentPage 里的取法）只读渲染 Markdown 文本 + 「去写作页」按钮 `setModule('write')`

- [ ] **Step 6: 挂载与删除旧页**

`apps/web/src/shell/AppShell.tsx`：

```tsx
import { CocreatePage } from '../pages/CocreatePage'
// ...
{module === 'agent' && <CocreatePage />}
```

删除 `apps/web/src/pages/AgentPage.tsx`（确认没有其他 import）。

- [ ] **Step 7: 构建 + 类型**

```bash
pnpm tsc
pnpm --filter @inkloom/web build
pnpm exec biome check apps/web/src/pages apps/web/src/agent-trace apps/web/src/shell apps/web/src/api
```

Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): rebuild cocreate around trace view and sessions"
```

---

### Task 9: README、真机验收与整支审查

**Files:**
- Modify: `README.md`
- Create: `docs/screenshots/accept-trace-viewer.png`
- Modify: `.superpowers/sdd/...`（ledger）

- [ ] **Step 1: 更新 README**

- 模块表「共创」：改成「会话列表 + trace 树 + 详情；可续接历史会话」
- 共创章节新增：
  - `TraceSpan` 视图说明（主笔 / 工具 / 子智能体 / 计划 / 门禁）
  - 会话管理与真续接（快照 + 裁剪）
  - 子体 `partial` 语义（「已收尾 · 步数上限」）
- 环境变量表不变
- `pnpm verify` 注释里的测试数改成实际值

- [ ] **Step 2: 重启服务做真机验收**

```bash
# 停掉旧的 8787，重启
$env:INKLOOM_LIBRARY = 'd:\Qwen-Agent\writing_test\test-1\.tmp-library'; pnpm api
```

按 spec §10 的 6 条逐项验收，记录实际的 span 层级、partial 状态、续接是否带上文。

- [ ] **Step 3: 截图**

1440×900，存 `docs/screenshots/accept-trace-viewer.png`：左会话列表、中 span 树（含一主一子）、右详情（子体完整结论）。

- [ ] **Step 4: 全量验证**

```bash
pnpm test
pnpm verify
```

Expected: 单元与集成全绿。把新的单元数写进 README 的 verify 注释。

- [ ] **Step 5: 整支 CodeReview**

派 CodeReview 子代理（范围：本切片所有提交），重点：
- 事件字段三处同步（runner / payload / web）
- 续接时 system 重建与工具集变化
- `compactMessages` 的边界（预算、最近 2 条、首条 user）
- 会话索引的并发写（writeQueue）与 legacy 补录
- TraceSpan 映射的配对（toolCallId、子体 id）与多 run 合并
- 删除 AgentPage 后是否有残留引用

- [ ] **Step 6: Commit 收尾**

```bash
git add -A README.md docs/screenshots
git commit -m "docs: document trace view, sessions and partial subagents"
```

---

## 自检

**1. Spec 覆盖**

| spec 章节 | 覆盖任务 |
|---|---|
| §3 子体软着陆 | Task 1 |
| §4 会话模型与存储 | Task 3（meta/journal）+ Task 4（run 绑定） |
| §4.4 messages 快照 | Task 2 |
| §5 真续接 | Task 2（裁剪）+ Task 5（入口） |
| §6 TraceSpan 映射 | Task 7 |
| §7 界面 | Task 8 |
| §8 AgentPrism 引入 | Task 6 |
| §9 HTTP 接口 | Task 5 |
| §10 测试与验收 | 各任务 + Task 9 |
| §11 风险 | Task 6（NOTICE + 排除）、Task 4/5（409）、Task 2（预算） |
| §12 文件清单 | 全部任务 |

**2. Placeholder 扫描**

- 无 TBD / TODO / 「类似 Task N」。
- Task 6 的 76 个上游文件用 `degit` 命令交付，不是占位；改动点逐条列出。
- Task 8 的 UI 代码是结构骨架（关键 props 与状态流完整），细节样式按项目现有风格实现。

**3. 类型一致性**

- `AgentSessionMeta`：Task 3 定义 → Task 7/8 消费，字段同名（`planDone` / `planTotal` / `resumable`）。
- `SubagentResult.partial`：Task 1 定义 → Task 7 的 `subagent.ended.partial` 消费。
- `AgentStreamEvent.runId`：Task 4 注入 → Task 7 的 `to-trace` 与 Task 8 的 `seen` 去重使用。
- `extraTabs`：Task 7 定义 → Task 8 传入。
- `TraceRecord` 必填字段（`id/name/spansCount/durationMs/agentDescription`）在 Task 7 与 Task 8 的 lite 转换里都齐全。

**4. 已知风险（执行时注意）**

- Task 6 是唯一无法完全预判的任务：上游源码在 strict 模式下可能报几十个类型错。修错时**不要**在 tsconfig 里 exclude；如果错误集中在少数文件，优先改上游文件的类型标注，并记进 NOTICE。
- Task 4 的 `persistSessionMeta` 与 `finalizePlanOnRunEnd` 都写磁盘，顺序敏感：meta 写失败不应影响 run 收尾，统一用 `void ... .catch()`。
- Task 8 的详情面板宽度在 1440 下约 420px；`DetailsView` 自带的 `react-resizable-panels` 可能不需要，若不使用可在 Task 6 里移除该依赖。
