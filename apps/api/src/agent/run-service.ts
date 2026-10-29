import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentEvent as PiEvent,
} from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import type { Plan } from '@inkloom/shared'
import { InkloomError, isPlanComplete, nextOpenTask } from '@inkloom/shared'
import { getContext, peekContext } from '../services/context.js'
import { clearCurrentPlan, loadPlan, readCurrentPlan, writePlanState } from '../storage/plans.js'
import { writeQueue } from '../storage/queue.js'
import {
  type CriticInput,
  type CriticVerdict,
  criticEnabled,
  decideCritic,
  parseCriticReport,
} from './critic.js'
import {
  compactMessages,
  loadMessageSnapshot,
  saveMessageSnapshot,
  sessionDir,
  stripSystemMessages,
} from './history.js'
import { deriveGate } from './plan-gate.js'
import { buildAgentPrompt, buildPlanRevisePrompt, buildTaskPrompt } from './prompt.js'
import type { AgentRoleId } from './roles.js'
import {
  type AgentSessionMeta,
  defaultTitle,
  isLegacyId,
  newSessionId,
  readSessionMeta,
  sessionJournalPath,
  updateSessionMeta,
} from './session-store.js'
import { createSubagentRunner, type SubagentResult } from './subagent.js'
import { type AgentGate, createAgentTools, type RunBudget } from './tools.js'

export type AgentRunStatus = 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped'

export type AgentStreamPayload =
  | { type: 'run.started'; goal: string }
  | { type: 'user.message'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'text.delta'; text: string }
  | { type: 'assistant.message'; text: string; thinking: string }
  | { type: 'tool.started'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool.ended'
      toolCallId: string
      toolName: string
      isError: boolean
      summary: string
    }
  | { type: 'gate.waiting'; gate: AgentGate }
  | { type: 'gate.resolved'; decision: 'approve' | 'revise' | 'skip'; feedback: string | null }
  | { type: 'plan.updated'; plan: Plan }
  | { type: 'subagent.started'; id: string; role: AgentRoleId; task: string }
  | {
      type: 'subagent.tool'
      id: string
      role: AgentRoleId
      toolCallId: string
      toolName: string
      ok: boolean
      summary: string
      steps: number
    }
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
  | { type: 'run.finished' }
  | { type: 'run.paused'; reason: string }
  | { type: 'run.failed'; error: string }
  | { type: 'run.stopped' }
  | { type: 'ping' }

export type AgentStreamEvent = AgentStreamPayload & { seq: number; at: string; runId: string }

export interface AgentRunSnapshot {
  id: string
  /** 所属会话：多次运行共享同一个会话 */
  sessionId: string
  goal: string
  status: AgentRunStatus
  startedAt: string
  finishedAt: string | null
  /** 当前计划 id；计划随事件 plan.updated 回放 */
  planId: string | null
  gate: AgentGate | null
  error: string | null
  budget: RunBudget
  tokens: number
  events: AgentStreamEvent[]
}

interface AgentRun {
  id: string
  /** 所属会话：多次运行共享同一个会话，journal 与快照都按会话落盘 */
  sessionId: string
  goal: string
  /** 归属：run 只能在创建它的书里被读取、审阅、续聊（切书后不允许跨书写入） */
  root: string
  projectId: string
  status: AgentRunStatus
  startedAt: string
  finishedAt: string | null
  planId: string | null
  gate: AgentGate | null
  error: string | null
  budget: RunBudget
  tokens: number
  events: AgentStreamEvent[]
  listeners: Set<(e: AgentStreamEvent) => void>
  seq: number
  agent: Agent
  stopped: boolean
  /** 本轮工具请求的门禁；agent_end 消费后必须清空，否则下一次 agent_end 会重复投出旧门禁 */
  gateBox: { current: AgentGate | null }
  journal: string
  journalTail: Promise<void>
  /** 上一轮结束时的步数：没涨 = 模型只说话没动手 */
  lastSteps: number
  /** 上一轮计划状态的指纹：与步数一起判断这一轮有没有真的推进 */
  lastPlanSignature: string
  /** 连续“没推进”的轮数；推两推还不动就停给作者 */
  stallTurns: number
  /** 正在跑的子体停止钩子：主 Agent.abort() 管不到独立子体 */
  childAborts: Set<() => void>
  /** 上一次写 meta 的时间：长 run 靠它节流刷新，避免被当成崩溃残留 */
  metaAt: number
  /** true = 续接的旧会话（会话被删后不能再写回去复活它） */
  adopted: boolean
  /** 本 run 是否已经落过盘：会话被删后再落盘不能重建一个空会话 */
  metaCreated: boolean
}

const runs = new Map<string, AgentRun>()
let activeRunId: string | null = null

function ownedByCurrentBook(run: AgentRun): boolean {
  const ctx = peekContext()
  return ctx !== null && run.root === ctx.root
}

/** 跨书访问一律当作不存在：不泄露另一本书的对话内容 */
function requireOwnedRun(id: string): AgentRun {
  const run = runs.get(id)
  if (run === undefined || !ownedByCurrentBook(run)) {
    throw new InkloomError('NOT_FOUND', `agent run ${id} 不存在（当前书里没有这个会话）`)
  }
  return run
}

/** 计划指纹：任务状态 + 计划状态，用来判断一轮有没有真的推进（只看步数会误判只读轮） */
function planSignature(plan: Plan | null): string {
  if (plan === null) return 'none'
  const tasks = plan.tasks.map((t) => `${t.id}:${t.status}:${t.reviewed ? 1 : 0}`).join(',')
  return `${plan.status}|${tasks}`
}

/**
 * 何时不该让 critic 的结论进一致性门禁（返回跳过理由）。
 * ★ 被步数/超时截断的 JSON 不完整：交给解析器只会得到误导的「不是合法 JSON」。
 */
export function criticSkipReason(r: SubagentResult): string | null {
  if (!r.ok) return (r.error ?? '').trim() || '子智能体失败'
  if (r.partial) return `一致性检查未跑完（${r.error ?? '中断'}）`
  if (r.text.trim().length === 0) return '子智能体没有给出检查结论'
  return null
}

/** 是否还有占用中的 run：切书前必须拒绝，避免把进度留在一个已关闭的 context 里 */
export function hasLiveAgentRun(): boolean {
  for (const run of runs.values()) {
    if (run.status === 'running' || run.status === 'waiting_review') return true
  }
  return false
}

/** 这个会话在本进程里是否真有正在跑/等审批的 run（meta 里的状态不算数：可能是崩溃残留） */
export function hasLiveAgentRunFor(sessionId: string): boolean {
  for (const run of runs.values()) {
    if (
      run.sessionId === sessionId &&
      (run.status === 'running' || run.status === 'waiting_review')
    ) {
      return true
    }
  }
  return false
}

/**
 * 清空已结束的 run。
 *
 * ★ done/stopped 的 run 必须清掉：`sendAgentMessage` 能把它们重新激活，
 *   留在内存里就会在切书后被“续聊”到另一本书。
 */
export function clearRuns(): number {
  let removed = 0
  for (const [id, run] of runs) {
    if (run.status === 'running' || run.status === 'waiting_review') continue
    runs.delete(id)
    removed += 1
  }
  if (activeRunId !== null && !runs.has(activeRunId)) activeRunId = null
  return removed
}

/** 仅测试：连 live run 一起清空，避免失败用例留下的 run 污染下一个用例 */
export function resetRunsForTest(): void {
  runs.clear()
  activeRunId = null
}

let modelsCache: ReturnType<typeof createModels> | null = null

function models(): ReturnType<typeof createModels> {
  if (modelsCache === null) {
    modelsCache = createModels()
    modelsCache.setProvider(deepseekProvider())
  }
  return modelsCache
}

function getModel() {
  const id = process.env['INKLOOM_AGENT_MODEL'] ?? 'deepseek-flash'
  const model = models().getModel('deepseek', id)
  if (model === undefined) {
    throw new InkloomError('INVALID_INPUT', `Pi 模型目录里找不到 deepseek/${id}`)
  }
  return model
}

function requireDeepseekKey(): string {
  const key = process.env['DEEPSEEK_API_KEY']?.trim() ?? ''
  if (key.length === 0) {
    throw new InkloomError('AUTH', '缺少 DEEPSEEK_API_KEY：先在「设置」里填好再启动 Agent')
  }
  return key
}

function newRunId(): string {
  return `ar_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function clip(text: string, max = 1500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（${text.length} 字符）`
}

function messageText(message: unknown): { text: string; thinking: string } {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return { text: '', thinking: '' }
  let text = ''
  let thinking = ''
  for (const part of content) {
    const p = part as { type?: string; text?: string; thinking?: string }
    if (p.type === 'text' && typeof p.text === 'string') text += p.text
    if (p.type === 'thinking' && typeof p.thinking === 'string') thinking += p.thinking
  }
  return { text, thinking }
}

function emit(run: AgentRun, event: AgentStreamPayload, journal = true): void {
  run.seq += 1
  const full = {
    ...event,
    seq: run.seq,
    at: new Date().toISOString(),
    runId: run.id,
  } as AgentStreamEvent
  run.events.push(full)
  if (run.events.length > 5000) run.events.splice(0, run.events.length - 5000)
  if (journal) {
    const line = `${JSON.stringify(full)}\n`
    run.journalTail = run.journalTail
      .then(() => appendFile(run.journal, line, 'utf8'))
      .catch((e) => console.warn(`[agent] 写 journal 失败：${(e as Error).message}`))
  }
  for (const l of run.listeners) {
    try {
      l(full)
    } catch {
      // 单个订阅者异常不能影响 run
    }
  }
  // ★ 长 run 中途也要刷 meta：超过 10 分钟没更新会被当成崩溃残留，允许被改名/删除
  if (Date.now() - run.metaAt > 30_000) {
    run.metaAt = Date.now()
    void persistSessionMeta(run)
  }
}

function handlePiEvent(run: AgentRun, e: PiEvent): void {
  switch (e.type) {
    case 'message_update': {
      const ev = e.assistantMessageEvent
      if (ev.type === 'thinking_delta') emit(run, { type: 'thinking.delta', text: ev.delta }, false)
      else if (ev.type === 'text_delta') emit(run, { type: 'text.delta', text: ev.delta }, false)
      return
    }
    case 'message_end': {
      const msg = e.message as { role?: string; usage?: { input?: number; output?: number } }
      if (msg.role === 'assistant') {
        const { text, thinking } = messageText(e.message)
        if (text.length > 0 || thinking.length > 0) {
          emit(run, { type: 'assistant.message', text, thinking })
        }
        const usage = msg.usage
        // ★ 与子体 onTokens 一致：停止后不再记账，否则主/子两侧的 tokens 口径对不上
        if (usage !== undefined && !run.stopped) {
          run.tokens += (usage.input ?? 0) + (usage.output ?? 0)
        }
      }
      return
    }
    case 'tool_execution_start': {
      emit(run, {
        type: 'tool.started',
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: e.args,
      })
      return
    }
    case 'tool_execution_end': {
      const result = e.result as { content?: { text?: string }[]; isError?: boolean }
      const text = (result.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n')
        .trim()
      emit(run, {
        type: 'tool.ended',
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        isError: e.isError,
        summary: clip(text.length === 0 ? '(无输出)' : text),
      })
      return
    }
    case 'agent_end': {
      // ★ 消费即清空：旧门禁不能活到下一轮。
      //   实测：批准计划后，任务 1 结束又把同一个 plan 门禁投了一次。
      const pending = run.gateBox.current
      run.gateBox.current = null
      if (pending !== null) {
        run.gate = pending
        run.status = 'waiting_review'
        emit(run, { type: 'gate.waiting', gate: pending })
      }
      return
    }
    default:
      return
  }
}

/**
 * 所有调用方都是 fire-and-forget（`void drive(...)`），所以这里必须**永不 reject**：
 * 一轮结束后还要落盘计划/写会话索引，磁盘写失败（如测试 teardown 删了临时目录）
 * 一旦冒出去就是未处理的 Promise rejection，会让整轮测试以非零码退出。
 */
async function drive(run: AgentRun, prompt: string): Promise<void> {
  try {
    await driveTurn(run, prompt)
  } catch (e) {
    if (run.stopped) return
    // failRun 自己也会落盘：二次失败只能咽下，否则又变回未处理 rejection
    await failRun(run, (e as Error).message).catch(() => undefined)
  }
}

async function driveTurn(run: AgentRun, prompt: string): Promise<void> {
  if (run.stopped) return
  // 新一轮开始：上一轮残留的门禁请求作废
  run.gateBox.current = null
  run.status = 'running'
  try {
    await run.agent.prompt(prompt)
  } catch (e) {
    if (run.stopped) return
    await failRun(run, (e as Error).message)
    return
  }
  if (run.stopped) return

  // 1. 本轮显式设了门禁（agent_end 已写入 run.gate）→ 等作者
  if (run.gate !== null) {
    run.status = 'waiting_review'
    void persistSessionMeta(run)
    return
  }

  // 2. 与 plan 对账：门禁是 plan 的投影，不是工具的副产物
  const plan = run.planId === null ? null : await loadPlan(run.root, run.planId).catch(() => null)

  // ★ 跑圈保护：这一轮既没调工具（步数没涨）也没改计划，推它也没用。
  //   两者任一有变化都算推进：只做研究不写计划的轮次不应被当成空转。
  const signature = planSignature(plan)
  if (run.budget.steps > run.lastSteps || signature !== run.lastPlanSignature) {
    run.stallTurns = 0
  } else {
    run.stallTurns += 1
  }
  run.lastSteps = run.budget.steps
  run.lastPlanSignature = signature

  if (plan !== null) {
    const gate = deriveGate(plan)
    if (gate !== null) {
      run.gate = gate
      run.status = 'waiting_review'
      emit(run, { type: 'gate.waiting', gate })
      void persistSessionMeta(run)
      return
    }

    if (plan.status === 'approved') {
      const next = nextOpenTask(plan)
      // ★ 预算用尽一律暂停（包括“任务全做完、还没请验收”）：
      //   否则 beforeToolCall 会拦住 request_review，drive 会一圈圈空转烧 token
      if (run.budget.steps >= run.budget.maxSteps) {
        pauseRun(
          run,
          next !== null
            ? `步数预算已用完（${run.budget.maxSteps} 步），还有任务没做完。点「继续执行」接着跑。`
            : `步数预算已用完（${run.budget.maxSteps} 步），还没能请作者验收。点「继续执行」继续。`,
        )
        return
      }
      // ★ 连续两轮不调工具（步数没涨）→ 再推也是空转：不管还有没有任务都停
      if (run.stallTurns >= 2) {
        pauseRun(
          run,
          '模型连续两轮没有调用工具，没法推进计划。点「继续执行」，或直接告诉它下一步做什么。',
        )
        return
      }
      if (next !== null) {
        const { project } = getContext()
        void drive(run, buildTaskPrompt(project, plan, next))
        return
      }
      // 全部任务完成，但还没请作者验收：推它一把
      void drive(
        run,
        '所有任务都已完成。请 read_book 核对一遍，然后调用 request_review(kind="plan", summary=...) 请作者验收整本书。',
      )
      return
    }
  }

  // 3. 没有计划 / 计划已完成：本轮收尾
  const error = run.agent.state.errorMessage
  if (error !== undefined && error.length > 0) {
    await failRun(run, error)
    return
  }
  run.status = 'done'
  run.finishedAt = new Date().toISOString()
  emit(run, { type: 'run.finished' })
  finishRun(run)
}

async function failRun(run: AgentRun, message: string, plan?: Plan | null): Promise<void> {
  run.status = 'failed'
  run.error = message
  run.finishedAt = new Date().toISOString()
  emit(run, { type: 'run.failed', error: message })
  await finalizePlanOnRunEnd(run, plan ?? undefined)
  finishRun(run)
}

/**
 * 步数耗尽：暂停而不是失败。
 * ★ 不调用 finalizePlanOnRunEnd：任务必须保持 doing，resume 才会从它接着做。
 * ★ 不设 run.error：这不是失败；原因只进事件流。
 */
function pauseRun(run: AgentRun, message: string): void {
  run.status = 'paused'
  run.finishedAt = new Date().toISOString()
  emit(run, { type: 'run.paused', reason: message })
  finishRun(run)
}

/** 把合并后的 plan 写回状态文件（定义已在 write_plan/update_plan 时写过） */
async function persistPlan(run: AgentRun, plan: Plan): Promise<void> {
  await writeQueue.run(async () => {
    await writePlanState(run.root, plan.id, {
      status: plan.status,
      summary: plan.summary,
      feedback: plan.feedback,
      tasks: plan.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        artifacts: t.artifacts,
        feedback: t.feedback,
        summary: t.summary,
        reviewed: t.reviewed,
      })),
      updatedAt: new Date().toISOString(),
    })
  })
  emit(run, { type: 'plan.updated', plan })
}

/** 按任务数放宽步数上限；章节与形象图已无额度 */
function refreshPlanBudget(run: AgentRun, plan: Plan): void {
  run.budget.maxSteps = Math.max(80, 80 + 2 * plan.tasks.length)
}

/**
 * 中止终态：stop / 异常时，不能把任务永久钉在 doing。
 *   doing → blocked（可恢复），未完成的计划 → aborted。
 * ★ 步数耗尽不走这里（走 pauseRun，任务保持 doing）。
 */
async function finalizePlanOnRunEnd(run: AgentRun, known?: Plan): Promise<void> {
  const plan =
    known ?? (run.planId === null ? null : await loadPlan(run.root, run.planId).catch(() => null))
  if (plan === null || plan.status === 'done' || plan.status === 'aborted') return
  let changed = false
  for (const t of plan.tasks) {
    if (t.status === 'doing') {
      t.status = 'blocked'
      changed = true
    }
  }
  if (plan.status === 'approved' || plan.status === 'awaiting_approval') {
    plan.status = 'aborted'
    changed = true
  }
  if (changed) await persistPlan(run, plan)
}

/** 打回：计划层重写计划，任务层带着意见重做 */
async function revise(run: AgentRun, gate: AgentGate, feedback: string): Promise<void> {
  const plan = run.planId === null ? null : await loadPlan(run.root, run.planId).catch(() => null)
  if (plan === null) {
    void drive(run, feedback)
    return
  }
  const { project } = getContext()
  if (gate.kind === 'plan') {
    plan.status = isPlanComplete(plan) ? 'approved' : 'drafting'
    plan.summary = null
    plan.feedback = feedback
    await persistPlan(run, plan)
    void drive(run, buildPlanRevisePrompt(plan, feedback))
    return
  }
  const task = plan.tasks.find((t) => t.id === gate.taskId)
  if (task === undefined) {
    void drive(run, feedback)
    return
  }
  task.status = 'doing'
  task.reviewed = false
  task.feedback = feedback
  task.summary = null
  await persistPlan(run, plan)
  void drive(run, buildTaskPrompt(project, plan, task))
}

function finishRun(run: AgentRun): void {
  if (activeRunId === run.id) activeRunId = null
  if (run.gate === null) run.finishedAt ??= new Date().toISOString()
  void persistSessionMeta(run)
}

/** 把 run 的当前状态写成会话索引；失败不影响 run 收尾 */
async function persistSessionMeta(run: AgentRun): Promise<void> {
  try {
    const plan = run.planId === null ? null : await loadPlan(run.root, run.planId).catch(() => null)
    const done = plan?.tasks.filter((t) => t.status === 'done').length ?? 0
    // ★ 队列内读改写：直接覆盖会抹掉同一时刻用户刚改的标题
    const meta = await updateSessionMeta(run.root, run.sessionId, (prev) => {
      // ★ 会话已被删：不复活（否则列表里会冒出一个打不开的空会话）。
      //   续接来的 run 一开始就不允许建；本 run 已经建过 meta 的话，删了就是删了。
      if (prev === null && (run.adopted || run.metaCreated)) return null
      const now = new Date().toISOString()
      if (prev !== null) {
        // ★ 本 run 首次落盘（还不在 runIds 里）或就是最新 run 时，才有权写状态。
        //    旧 run 的收尾只登记自己，不改状态与进度，否则会把新 run 的 running 覆盖成 done。
        const owning = !prev.runIds.includes(run.id) || prev.runIds.at(-1) === run.id
        if (!owning) {
          return { ...prev, updatedAt: now, runIds: [...new Set([...prev.runIds, run.id])] }
        }
      }
      return {
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
        planTitle: plan?.title ?? prev?.planTitle ?? null,
        planDone: done,
        planTotal: plan?.tasks.length ?? 0,
        runIds: [...new Set([...(prev?.runIds ?? []), run.id])],
        resumable: run.status !== 'running' && run.status !== 'waiting_review',
      }
    })
    if (meta === null) return
    run.metaCreated = true
    await saveMessageSnapshot(run.root, run.sessionId, {
      version: 1,
      savedAt: meta.updatedAt,
      sessionId: run.sessionId,
      runId: run.id,
      messages: run.agent.state.messages ?? [],
    })
  } catch (e) {
    const message = (e as Error).message
    // 书目录已被删/切走时写不进去是正常的；其余错误才值得告警
    if (!message.includes('ENOENT')) {
      console.warn(`[agent] 写会话索引失败：${message}`)
    }
  }
}

/**
 * 重新规划前把旧计划收尾：作者已放弃它，不能继续挂在 approved 上。
 * ★ 不走 persistPlan：它需要一个 run，而新 run 这时还没建出来。
 */
async function abandonPriorPlan(root: string, plan: Plan): Promise<void> {
  if (plan.status === 'done' || plan.status === 'aborted') return
  await writeQueue.run(async () => {
    await writePlanState(root, plan.id, {
      status: 'aborted',
      summary: plan.summary,
      feedback: plan.feedback,
      tasks: plan.tasks.map((t) => ({
        id: t.id,
        status: t.status === 'doing' ? ('blocked' as const) : t.status,
        artifacts: t.artifacts,
        feedback: t.feedback,
        summary: t.summary,
        reviewed: t.reviewed,
      })),
      updatedAt: new Date().toISOString(),
    })
  })
}

/**
 * 「继续执行」：把中止的计划救回来。
 *
 * ★ 上一轮 doing 不能直接复活成 doing（那会把没做完的步骤当成已完成），先转 blocked；
 *   drive 会从 blocked 任务重新开始。
 * ★ 不重置 task.reviewed：已经通过的任务不能因为这一下又变回待审。
 */
async function reopenAbortedPlan(root: string, plan: Plan): Promise<void> {
  const tasks = plan.tasks.map((t) =>
    t.status === 'doing' ? { ...t, status: 'blocked' as const } : t,
  )
  plan.tasks = tasks
  plan.status = 'approved'
  plan.feedback = null
  await writeQueue.run(async () => {
    await writePlanState(root, plan.id, {
      status: 'approved',
      summary: plan.summary,
      feedback: null,
      tasks: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        artifacts: t.artifacts,
        feedback: t.feedback,
        summary: t.summary,
        reviewed: t.reviewed,
      })),
      updatedAt: new Date().toISOString(),
    })
  })
}

export async function startAgentRun(
  goal: string,
  options: {
    mode?: 'new' | 'resume' | 'replan'
    /** 续接时沿用旧会话；不传则新建 */
    sessionId?: string
    /** 续接时的历史消息（会自动剥掉旧 system） */
    messages?: AgentMessage[]
    /** 本轮要跑的作者原话（续接时用，替代默认的开场 prompt） */
    prompt?: string
  } = {},
): Promise<AgentRunSnapshot> {
  const { root, project } = getContext()
  // ★ legacy 会话只读：放进来会写到一个永远读不回来的 journal
  if (options.sessionId !== undefined && isLegacyId(options.sessionId)) {
    throw new InkloomError('CONFLICT', '历史会话只读，不能续接；请新建会话')
  }
  if (activeRunId !== null) {
    const active = runs.get(activeRunId)
    if (
      active !== undefined &&
      (active.status === 'running' || active.status === 'waiting_review')
    ) {
      throw new InkloomError(
        'CONFLICT',
        `已有进行中的 Agent（${active.id} · ${active.status === 'waiting_review' ? '等待审阅' : '运行中'}），先处理它`,
      )
    }
    activeRunId = null
  }

  const apiKey = requireDeepseekKey()
  const model = getModel()
  const imageApiKey = process.env['SILICONFLOW_API_KEY']?.trim() ?? null

  const budget: RunBudget = {
    steps: 0,
    maxSteps: 80,
    chapterCalls: 0,
    portraitCalls: 0,
    subagentCalls: 0,
  }
  const gateBox: { current: AgentGate | null } = { current: null }

  // 恢复上一次没做完的计划：等批准 → 直接恢复门禁；已批准 → 接着做下一个任务
  // ★ 只有 mode=resume 才自动接旧计划：作者点「开始共创」时输入了新目标，
  //   再拿旧计划覆盖他的指令就是「不听人话」。
  const mode = options.mode ?? 'resume'
  const currentPlanId = await readCurrentPlan(root)
  const prior = currentPlanId === null ? null : await loadPlan(root, currentPlanId)
  const replacesPrior = mode === 'new' || mode === 'replan'
  const priorToClose = replacesPrior ? prior : null
  if (priorToClose !== null) {
    await abandonPriorPlan(root, priorToClose)
    await clearCurrentPlan(root)
  }
  const resumable =
    !replacesPrior &&
    prior !== null &&
    (prior.status === 'aborted' ||
      prior.status === 'drafting' ||
      prior.status === 'awaiting_approval' ||
      prior.status === 'approved')
      ? prior
      : null

  const id = newRunId()
  const sessionId = options.sessionId ?? newSessionId()
  // ★ 只有磁盘上真的存在才算「续接」：客户端传了个新 id 时仍要正常建索引
  const adopted =
    options.sessionId !== undefined && (await readSessionMeta(root, sessionId)) !== null
  const journal = sessionJournalPath(root, sessionId)
  await mkdir(sessionDir(root), { recursive: true })

  let run!: AgentRun
  // ★ runner 需要「工具全集」，工具又需要 runner：用惰性 getter 打破构造期循环。
  //   只有 delegate / critic 执行时才会读到 allTools，那时它已经赋值。
  let allTools: AgentTool[] = []
  const childAborts = new Set<() => void>()
  const subagent = createSubagentRunner({
    model,
    streamFn: models().streamSimple.bind(models()),
    getTools: () => allTools,
    budget,
    onEvent: (e) => {
      // ★ 作者已点停止：不再往已停止的 run 写事件
      if (run.stopped) return
      if (e.type === 'started') {
        emit(run, {
          type: 'subagent.started',
          id: e.id,
          role: e.role,
          // critic 的任务是拼出来的，summary/brief 可能很长；事件进 journal，必须截
          task: clip(e.task, 500),
        })
        return
      }
      if (e.type === 'tool') {
        emit(run, {
          type: 'subagent.tool',
          id: e.id,
          role: e.role,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          ok: e.ok,
          summary: e.summary,
          steps: e.steps,
        })
        return
      }
      emit(run, {
        type: 'subagent.ended',
        id: e.id,
        role: e.role,
        ok: e.ok,
        partial: e.partial,
        steps: e.steps,
        tokens: e.tokens,
        summary: e.summary,
        // ★ subagent 已按 6000 字截断；这里只是防止异常长文本进 journal，保持原文换行
        text: e.text.length <= 6000 ? e.text : `${e.text.slice(0, 6000)}…`,
        error: e.error,
      })
    },
    onTokens: (n) => {
      if (run.stopped) return
      run.tokens += n
    },
    registerAbort: (abort) => {
      childAborts.add(abort)
      return () => {
        childAborts.delete(abort)
      }
    },
  })

  const critic = criticEnabled(process.env['INKLOOM_CRITIC'])
    ? async (input: CriticInput): Promise<CriticVerdict> => {
        const task = [
          '# 任务',
          `检查任务 ${input.taskId}「${input.title}」的完成情况是否与本书设定矛盾。`,
          `计划目标：${input.goal}`,
          `任务要求：${input.brief.length === 0 ? '（未填）' : input.brief}`,
          `本次产物：${input.artifacts.length === 0 ? '（未填）' : input.artifacts.join('、')}`,
          `主 Agent 的完成说明：${input.summary ?? '（无）'}`,
          '',
          '先用 read_book 看设定全貌，需要时用 query_graph / explain_fact 核对具体关系。',
        ].join('\n')
        const r = await subagent({ role: 'critic', task })
        const skip = criticSkipReason(r)
        if (skip !== null) return { kind: 'skipped', reason: skip }
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
    // ★ run 在下面才赋值，工具执行时一定已赋值（同 getPlanId 的闭包写法）
    getRunId: () => run.id,
    subagent,
    ...(critic === undefined ? {} : { critic }),
  })
  allTools = tools

  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentPrompt(project, goal),
      model,
      thinkingLevel: 'low',
      tools: tools as AgentTool[],
      // ★ 续接：只恢复作者与模型的对话，system 由当前代码重建（工具集会变）
      ...(options.messages === undefined
        ? {}
        : { messages: stripSystemMessages(options.messages) }),
    },
    streamFn: models().streamSimple.bind(models()),
    toolExecution: 'sequential',
    // ★ 长会话逐轮裁剪：保留 system，其余按预算压缩（不会拆散 toolCall 配对）
    transformContext: async (current) => {
      try {
        const system = current.filter((m) => (m as { role?: string }).role === 'system')
        return [...system, ...compactMessages(current)]
      } catch {
        // ★ Pi 要求 transformContext 不能抛：抛了 run 会卡在 running，连失败事件都没有
        return current
      }
    },
    beforeToolCall: async () => {
      if (budget.steps >= budget.maxSteps) {
        return {
          block: true,
          reason: `步数预算已用完（${budget.maxSteps} 步），请作者点「继续执行」`,
        }
      }
      budget.steps += 1
      return undefined
    },
  })

  run = {
    id,
    sessionId,
    goal,
    root,
    projectId: project.id,
    planId: resumable?.id ?? null,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    gate: null,
    error: null,
    budget,
    tokens: 0,
    events: [],
    listeners: new Set(),
    seq: 0,
    agent,
    stopped: false,
    gateBox,
    journal,
    journalTail: Promise.resolve(),
    lastSteps: 0,
    lastPlanSignature: '',
    stallTurns: 0,
    childAborts,
    metaAt: Date.now(),
    adopted,
    metaCreated: false,
  }

  agent.subscribe((e) => handlePiEvent(run, e))
  runs.set(id, run)
  activeRunId = id
  emit(run, { type: 'run.started', goal })
  // ★ 只给了 sessionId 却没给 messages：不能拿空快照覆盖掉已有历史
  if (!(options.sessionId !== undefined && options.messages === undefined)) {
    await persistSessionMeta(run)
  }

  if (resumable !== null) {
    // 中止的计划：作者点「继续执行」就是显式恢复，先把状态救回来再续跑
    if (resumable.status === 'aborted') await reopenAbortedPlan(root, resumable)
    emit(run, { type: 'plan.updated', plan: resumable })
    refreshPlanBudget(run, resumable)
    // 上次正等作者批准：不叫模型，直接把门禁恢复出来
    if (resumable.status === 'awaiting_approval') {
      const gate = deriveGate(resumable)
      // ★ 作者带话进来时不能把话吞掉：本轮先跑他的话，门禁下次再请
      if (gate !== null && options.prompt === undefined) {
        run.gate = gate
        run.status = 'waiting_review'
        emit(run, { type: 'gate.waiting', gate })
        await persistSessionMeta(run)
        return snapshot(run)
      }
    }
  }

  let initialPrompt = buildAgentPrompt(project, goal)
  if (options.prompt !== undefined) {
    // ★ 续接以作者这句话为主语：不能再拼「继续做任务 X」的命令式提示，否则会盖过他的指令
    const planHint =
      resumable === null
        ? ''
        : `\n\n（上次会话留下计划《${resumable.title}》id=${resumable.id}；先按作者这句话行事，需要时再 update_plan。）`
    initialPrompt = `${initialPrompt}\n\n# 作者刚说\n${options.prompt}${planHint}`
  } else if (mode === 'replan' && priorToClose !== null) {
    initialPrompt = `${buildAgentPrompt(project, goal)}

# 重新规划
作者放弃了上一份计划《${priorToClose.title}》（id=${priorToClose.id}，已标为中止）。请 read_book 之后用 write_plan 提交一份新计划；不要用 update_plan 修补旧计划。`
  } else if (resumable !== null && resumable.status === 'approved') {
    const next = nextOpenTask(resumable)
    initialPrompt =
      next !== null
        ? buildTaskPrompt(project, resumable, next)
        : '所有任务都已完成。请 read_book 核对一遍，然后调用 request_review(kind="plan", summary=...) 请作者验收整本书。'
  } else if (resumable !== null && resumable.status === 'drafting') {
    initialPrompt = `${buildAgentPrompt(project, goal)}

# 继续上一次的计划
上一次会话留下了未完成的计划《${resumable.title}》（id=${resumable.id}）。请 read_book 后继续：用 update_plan 修订并 request_review(kind="plan")，不要重新 write_plan。`
  }

  // ★ 先记作者这句话，再开跑：与 sendAgentMessage 的顺序一致，前端不会错位
  if (options.prompt !== undefined) emit(run, { type: 'user.message', text: options.prompt })
  void drive(run, initialPrompt)
  return snapshot(run)
}

/**
 * 新建会话：返回 run 与它的会话索引（写盘已在 startAgentRun 里 await 过）。
 */
export async function startSession(
  goal: string,
  mode: 'new' | 'resume' | 'replan' = 'new',
): Promise<{ run: AgentRunSnapshot; meta: AgentSessionMeta }> {
  const run = await startAgentRun(goal, { mode })
  const { root } = getContext()
  const meta = await readSessionMeta(root, run.sessionId)
  if (meta === null) throw new InkloomError('CONFLICT', '会话元信息创建失败')
  return { run, meta }
}

/**
 * 真续接：用 messages 快照重建 Agent，再把作者这句话当作本轮输入。
 * ★ 正在跑/等审批的会话不走这里（需要在原 run 上处理）。
 */
export async function resumeSession(sessionId: string, text: string): Promise<AgentRunSnapshot> {
  const { root } = getContext()
  if (isLegacyId(sessionId)) {
    throw new InkloomError('CONFLICT', '历史记录只读，不能续接')
  }
  // ★ 只看内存里的 live run：meta 里的 running/waiting_review 可能是进程崩溃后的残留
  if (hasLiveAgentRunFor(sessionId)) {
    throw new InkloomError('CONFLICT', '会话还在运行或等待审批，先在原会话里处理')
  }
  const meta = await readSessionMeta(root, sessionId)
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${sessionId} 不存在`)
  const snapshot = await loadMessageSnapshot(root, sessionId)
  if (snapshot === null) {
    throw new InkloomError('CONFLICT', '这个会话没有可续接的记录（消息快照缺失）')
  }
  return startAgentRun(meta.goal, {
    mode: 'resume',
    sessionId,
    messages: snapshot.messages,
    prompt: text,
  })
}

/**
 * 继续执行：停在预算/失败/中止后的计划，可以被重新推进。
 * ★ 只有已结束的 run 能恢复；正在跑/等待审阅的不能走这条路。
 * ★ aborted 改回 approved：这是作者显式点「继续执行」的意思。
 */
export function resumeAgentRun(id: string): AgentRunSnapshot {
  const run = requireOwnedRun(id)
  if (run.status === 'running' || run.status === 'waiting_review') {
    throw new InkloomError('INVALID_INPUT', '这个 run 还在进行中，不需要恢复')
  }
  if (run.planId === null) throw new InkloomError('INVALID_INPUT', '这个 run 没有可继续的计划')

  run.status = 'running'
  run.stopped = false
  run.finishedAt = null
  run.error = null
  run.budget.steps = 0
  run.lastSteps = 0
  run.lastPlanSignature = ''
  run.stallTurns = 0
  activeRunId = run.id
  emit(run, { type: 'user.message', text: '继续执行计划里还没完成的任务' })

  void (async () => {
    const plan = await loadPlan(run.root, run.planId as string).catch(() => null)
    if (plan === null) {
      await failRun(run, '计划文件不见了，无法继续')
      return
    }
    if (plan.status === 'aborted') {
      plan.status = 'approved'
      await persistPlan(run, plan)
    }
    const next = nextOpenTask(plan)
    if (next === null) {
      run.status = 'done'
      run.finishedAt = new Date().toISOString()
      emit(run, { type: 'run.finished' })
      finishRun(run)
      return
    }
    const { project } = getContext()
    void drive(run, buildTaskPrompt(project, plan, next))
    // 同上：这个 IIFE 是 fire-and-forget，落盘失败不能变成未处理 rejection
  })().catch((e: unknown) => {
    if (!run.stopped) void failRun(run, (e as Error).message).catch(() => undefined)
  })

  return snapshot(run)
}

export function getAgentRun(id: string): AgentRunSnapshot | null {
  const run = runs.get(id)
  if (run === undefined || !ownedByCurrentBook(run)) return null
  return snapshot(run)
}

export function subscribeAgentRun(id: string, listener: (e: AgentStreamEvent) => void): () => void {
  const run = runs.get(id)
  if (run === undefined || !ownedByCurrentBook(run)) return () => undefined
  run.listeners.add(listener)
  return () => run.listeners.delete(listener)
}

export function stopAgentRun(id: string): AgentRunSnapshot {
  const run = requireOwnedRun(id)
  if (run.status === 'running' || run.status === 'waiting_review') {
    run.stopped = true
    run.status = 'stopped'
    run.finishedAt = new Date().toISOString()
    run.gate = null
    run.agent.abort()
    // ★ 子体是独立 Agent：主 Agent 的 abort() 停不住它，必须逐个停
    for (const abort of run.childAborts) abort()
    emit(run, { type: 'run.stopped' })
    // doing 不能永久钉住：停止时把当前任务标成 blocked，计划标成 aborted
    void finalizePlanOnRunEnd(run)
    finishRun(run)
  }
  return snapshot(run)
}

export async function reviewAgentRun(
  id: string,
  decision: 'approve' | 'revise' | 'skip',
  feedback: string | null,
): Promise<AgentRunSnapshot> {
  const run = requireOwnedRun(id)
  if (run.status !== 'waiting_review' || run.gate === null) {
    throw new InkloomError('INVALID_INPUT', '这个 run 现在不在等待审阅')
  }
  if (decision === 'skip' && run.gate.kind === 'plan') {
    throw new InkloomError('INVALID_INPUT', '计划门禁不能跳过：请批准，或打回让它重写')
  }
  if (decision === 'revise' && (feedback === null || feedback.trim().length === 0)) {
    throw new InkloomError('INVALID_INPUT', '打回必须写清楚要改什么')
  }
  const gate = run.gate
  run.gate = null
  emit(run, { type: 'gate.resolved', decision, feedback })

  if (decision === 'revise') {
    await revise(run, gate, feedback ?? '')
    return snapshot(run)
  }

  // 批准：门禁是 plan 的投影，批准就是推进 plan 状态
  const plan = run.planId === null ? null : await loadPlan(run.root, run.planId).catch(() => null)
  if (plan === null) {
    run.status = 'done'
    run.finishedAt = new Date().toISOString()
    emit(run, { type: 'run.finished' })
    finishRun(run)
    return snapshot(run)
  }

  const { project } = getContext()

  if (gate.kind === 'plan') {
    plan.summary = null
    plan.feedback = null
    if (isPlanComplete(plan)) {
      plan.status = 'done'
      await persistPlan(run, plan)
      run.status = 'done'
      run.finishedAt = new Date().toISOString()
      emit(run, { type: 'run.finished' })
      finishRun(run)
      return snapshot(run)
    }
    plan.status = 'approved'
    refreshPlanBudget(run, plan)
    await persistPlan(run, plan)
    const next = nextOpenTask(plan)
    if (next === null) {
      run.status = 'done'
      run.finishedAt = new Date().toISOString()
      emit(run, { type: 'run.finished' })
      finishRun(run)
      return snapshot(run)
    }
    void drive(run, buildTaskPrompt(project, plan, next))
    return snapshot(run)
  }

  const task = plan.tasks.find((t) => t.id === gate.taskId)
  if (task === undefined) {
    throw new InkloomError('INVALID_INPUT', `计划里没有任务 ${gate.taskId}`)
  }
  // 跳过 = 作者明确表示这件事不做了：任务收尾，计划继续往下走
  if (decision === 'skip') task.status = 'skipped'
  task.reviewed = true
  task.summary = null
  task.feedback = null
  await persistPlan(run, plan)
  const next = nextOpenTask(plan)
  void drive(
    run,
    next !== null
      ? buildTaskPrompt(project, plan, next)
      : '所有任务都已完成。请 read_book 核对一遍，然后调用 request_review(kind="plan", summary=...) 请作者验收整本书。',
  )
  return snapshot(run)
}

/**
 * 对话式共创：任何时刻都可以再说话。
 *
 * - 运行中：steer 到当前轮之后，不打断正在跑的工具；
 * - 等待审阅：视为「带修改意见的打回」，本阶段重做；
 * - 已完成/已停止：同一段 transcript 接着聊，不再重开 run。
 */
export function sendAgentMessage(id: string, text: string): AgentRunSnapshot {
  const run = requireOwnedRun(id)
  if (run.status === 'failed') {
    throw new InkloomError('INVALID_INPUT', '这个 run 失败了，请开新会话')
  }
  if (run.status === 'paused') {
    throw new InkloomError('INVALID_INPUT', '这个 run 已暂停：点「继续执行」接着跑')
  }
  emit(run, { type: 'user.message', text })

  if (run.status === 'running') {
    run.agent.steer({ role: 'user', content: text, timestamp: Date.now() })
    return snapshot(run)
  }

  if (run.status === 'waiting_review' && run.gate !== null) {
    const gate = run.gate
    run.gate = null
    emit(run, { type: 'gate.resolved', decision: 'revise', feedback: text })
    void revise(run, gate, text)
    return snapshot(run)
  }

  run.status = 'running'
  run.stopped = false
  run.finishedAt = null
  activeRunId = run.id
  // 续聊重置步数（章节与形象图已无额度）与跑圈计数
  run.budget.steps = 0
  run.lastSteps = 0
  run.lastPlanSignature = ''
  run.stallTurns = 0
  void drive(run, text)
  return snapshot(run)
}

function snapshot(run: AgentRun): AgentRunSnapshot {
  return {
    id: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    planId: run.planId,
    gate: run.gate,
    error: run.error,
    budget: run.budget,
    tokens: run.tokens,
    events: run.events.slice(),
  }
}
