import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Agent, type AgentTool, type AgentEvent as PiEvent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { InkloomError } from '@inkloom/shared'
import { getContext } from '../services/context.js'
import { agentRunDir } from './book-snapshot.js'
import { buildAgentPrompt } from './prompt.js'
import { type AgentGate, createAgentTools, type ReviewStage, type RunBudget } from './tools.js'

export type AgentRunStatus = 'running' | 'waiting_review' | 'done' | 'failed' | 'stopped'

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
  | { type: 'gate.resolved'; decision: 'approve' | 'revise'; feedback: string | null }
  | { type: 'run.finished' }
  | { type: 'run.failed'; error: string }
  | { type: 'run.stopped' }
  | { type: 'ping' }

export type AgentStreamEvent = AgentStreamPayload & { seq: number; at: string }

export interface AgentRunSnapshot {
  id: string
  goal: string
  status: AgentRunStatus
  startedAt: string
  finishedAt: string | null
  gate: AgentGate | null
  error: string | null
  budget: RunBudget
  tokens: number
  events: AgentStreamEvent[]
}

interface AgentRun {
  id: string
  goal: string
  status: AgentRunStatus
  startedAt: string
  finishedAt: string | null
  gate: AgentGate | null
  error: string | null
  budget: RunBudget
  tokens: number
  events: AgentStreamEvent[]
  listeners: Set<(e: AgentStreamEvent) => void>
  seq: number
  agent: Agent
  stopped: boolean
  journal: string
  journalTail: Promise<void>
}

const runs = new Map<string, AgentRun>()
let activeRunId: string | null = null

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
  const full = { ...event, seq: run.seq, at: new Date().toISOString() } as AgentStreamEvent
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
}

function handlePiEvent(run: AgentRun, e: PiEvent, gateBox: { current: AgentGate | null }): void {
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
        if (usage !== undefined) run.tokens += (usage.input ?? 0) + (usage.output ?? 0)
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
      if (gateBox.current !== null) {
        run.gate = gateBox.current
        run.status = 'waiting_review'
        emit(run, { type: 'gate.waiting', gate: gateBox.current })
      }
      return
    }
    default:
      return
  }
}

async function drive(run: AgentRun, prompt: string): Promise<void> {
  if (run.stopped) return
  run.status = 'running'
  try {
    await run.agent.prompt(prompt)
  } catch (e) {
    if (run.stopped) return
    run.status = 'failed'
    run.error = (e as Error).message
    run.finishedAt = new Date().toISOString()
    emit(run, { type: 'run.failed', error: run.error })
    finishRun(run)
    return
  }
  if (run.stopped) return
  if (run.gate !== null) return

  const error = run.agent.state.errorMessage
  if (error !== undefined && error.length > 0) {
    run.status = 'failed'
    run.error = error
    emit(run, { type: 'run.failed', error })
  } else {
    run.status = 'done'
    emit(run, { type: 'run.finished' })
  }
  run.finishedAt = new Date().toISOString()
  finishRun(run)
}

function finishRun(run: AgentRun): void {
  if (activeRunId === run.id) activeRunId = null
  if (run.gate === null) run.finishedAt ??= new Date().toISOString()
}

export async function startAgentRun(goal: string): Promise<AgentRunSnapshot> {
  const { root, project } = getContext()
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
    maxSteps: 40,
    chapterCalls: 0,
    maxChapters: 1,
    portraitCalls: 0,
    maxPortraits: 1,
  }
  const gateBox: { current: AgentGate | null } = { current: null }

  const tools = createAgentTools({
    apiKey,
    imageApiKey: imageApiKey === null || imageApiKey.length === 0 ? null : imageApiKey,
    model: model.id,
    budget,
    onGate: (gate) => {
      gateBox.current = gate
    },
  })

  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentPrompt(project),
      model,
      thinkingLevel: 'low',
      tools: tools as AgentTool[],
    },
    streamFn: models().streamSimple.bind(models()),
    toolExecution: 'sequential',
    beforeToolCall: async () => {
      if (budget.steps >= budget.maxSteps) {
        return { block: true, reason: `步数预算已用完（${budget.maxSteps} 步），请作者开新一轮` }
      }
      budget.steps += 1
      return undefined
    },
  })

  const id = newRunId()
  const journal = join(agentRunDir(root), `${id}.jsonl`)
  await mkdir(agentRunDir(root), { recursive: true })

  let run!: AgentRun
  run = {
    id,
    goal,
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
    journal,
    journalTail: Promise.resolve(),
  }

  agent.subscribe((e) => handlePiEvent(run, e, gateBox))
  runs.set(id, run)
  activeRunId = id
  emit(run, { type: 'run.started', goal })
  void drive(run, goal)
  return snapshot(run)
}

export function getAgentRun(id: string): AgentRunSnapshot | null {
  const run = runs.get(id)
  return run === undefined ? null : snapshot(run)
}

export function subscribeAgentRun(id: string, listener: (e: AgentStreamEvent) => void): () => void {
  const run = runs.get(id)
  if (run === undefined) return () => undefined
  run.listeners.add(listener)
  return () => run.listeners.delete(listener)
}

export function stopAgentRun(id: string): AgentRunSnapshot {
  const run = runs.get(id)
  if (run === undefined) throw new InkloomError('NOT_FOUND', `agent run ${id} 不存在`)
  if (run.status === 'running' || run.status === 'waiting_review') {
    run.stopped = true
    run.status = 'stopped'
    run.finishedAt = new Date().toISOString()
    run.gate = null
    run.agent.abort()
    emit(run, { type: 'run.stopped' })
    finishRun(run)
  }
  return snapshot(run)
}

export async function reviewAgentRun(
  id: string,
  decision: 'approve' | 'revise',
  feedback: string | null,
): Promise<AgentRunSnapshot> {
  const run = runs.get(id)
  if (run === undefined) throw new InkloomError('NOT_FOUND', `agent run ${id} 不存在`)
  if (run.status !== 'waiting_review' || run.gate === null) {
    throw new InkloomError('INVALID_INPUT', '这个 run 现在不在等待审阅')
  }
  if (decision === 'revise' && (feedback === null || feedback.trim().length === 0)) {
    throw new InkloomError('INVALID_INPUT', '打回必须写清楚要改什么')
  }
  const gate = run.gate
  run.gate = null
  emit(run, { type: 'gate.resolved', decision, feedback })

  // ★ draft 是最后一站：作者通过开篇 = 本轮结束。
  //   否则 agent 会以为“还可以继续”，再开一次 draft 门禁（实测发生过）。
  if (gate.stage === 'draft' && decision === 'approve') {
    run.status = 'done'
    run.finishedAt = new Date().toISOString()
    emit(run, { type: 'run.finished' })
    finishRun(run)
    return snapshot(run)
  }

  void drive(
    run,
    decision === 'approve' ? approvePrompt(gate.stage) : revisePrompt(gate.stage, feedback ?? ''),
  )
  return snapshot(run)
}

function approvePrompt(stage: ReviewStage): string {
  return `作者已通过「${stage}」阶段。请继续下一阶段；如果需要写文件，先回顾 read_book 的快照再动手。`
}

function revisePrompt(stage: ReviewStage, feedback: string): string {
  return `作者打回了「${stage}」阶段。意见：${feedback}\n请按意见修改相关文件，改完再次调用 request_review(stage="${stage}")。`
}

/**
 * 对话式共创：任何时刻都可以再说话。
 *
 * - 运行中：steer 到当前轮之后，不打断正在跑的工具；
 * - 等待审阅：视为「带修改意见的打回」，本阶段重做；
 * - 已完成/已停止：同一段 transcript 接着聊，不再重开 run。
 */
export function sendAgentMessage(id: string, text: string): AgentRunSnapshot {
  const run = runs.get(id)
  if (run === undefined) throw new InkloomError('NOT_FOUND', `agent run ${id} 不存在`)
  if (run.status === 'failed') {
    throw new InkloomError('INVALID_INPUT', '这个 run 失败了，请开新会话')
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
    void drive(run, revisePrompt(gate.stage, text))
    return snapshot(run)
  }

  run.status = 'running'
  run.stopped = false
  run.finishedAt = null
  activeRunId = run.id
  void drive(run, text)
  return snapshot(run)
}

function snapshot(run: AgentRun): AgentRunSnapshot {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    gate: run.gate,
    error: run.error,
    budget: run.budget,
    tokens: run.tokens,
    events: run.events.slice(),
  }
}
