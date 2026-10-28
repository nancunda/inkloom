import { randomUUID } from 'node:crypto'
import {
  Agent,
  type AgentEvent,
  type AgentInitialState,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import { AGENT_ROLES, type AgentRoleId, isAgentRoleId, toolsForRole } from './roles.js'
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
  /** 注册外部停止钩子（作者点「停止」）；返回注销函数 */
  registerAbort?: (abort: () => void) => () => void
  timeoutMs?: number
}

const MAX_TEXT = 6000
const DEFAULT_TIMEOUT_MS = 120_000

function taskMessage(req: SubagentRequest): string {
  const lines = ['# 任务', req.task.trim()]
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
    const id = `sa_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    // ★ 运行期校验：role 可能来自模型参数，类型系统管不到；非法值不发事件、不计数
    if (!isAgentRoleId(req.role)) {
      return {
        id,
        role: req.role,
        ok: false,
        steps: 0,
        tokens: 0,
        text: '',
        error: `未知角色 ${req.role}`,
      }
    }
    const role = AGENT_ROLES[req.role]
    deps.budget.subagentCalls += 1
    deps.onEvent({ type: 'started', id, role: role.id, task: req.task })

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let steps = 0
    let tokens = 0
    let text = ''
    let error: string | null = null
    let timedOut = false
    let externalStop = false
    /** 步数触顶不会写 state.errorMessage，必须自己记下来，否则会以「成功但空结论」返回 */
    let limitReason: string | null = null

    const beforeToolCall = async (_ctx: unknown, signal?: AbortSignal) => {
      // 已 abort 的调用不会执行，不能白扣主预算
      if (signal?.aborted === true) return undefined
      // ★ 双上限：主预算保护整场会话，角色上限保护单次子任务
      if (deps.budget.steps >= deps.budget.maxSteps) {
        limitReason = `主会话步数预算已用尽（${deps.budget.maxSteps} 步）`
        return { block: true, terminate: true, reason: limitReason }
      }
      if (steps >= role.maxSteps) {
        limitReason = `子任务步数上限（${role.maxSteps} 步）`
        return { block: true, terminate: true, reason: limitReason }
      }
      deps.budget.steps += 1
      steps += 1
      return undefined
    }

    const onEvent = (e: AgentEvent): void => {
      if (e.type === 'message_end') {
        const msg = e.message as { role?: string; usage?: { input?: number; output?: number } }
        if (msg.role !== 'assistant') return
        // ★ 超时后仍要记账：已经结算的 usage 是真实成本，不该因为 abort 而少算
        const usage = msg.usage
        if (usage !== undefined) {
          const n = (usage.input ?? 0) + (usage.output ?? 0)
          if (n > 0) {
            tokens += n
            deps.onTokens(n)
          }
        }
        if (timedOut) return
        const t = assistantText(e.message)
        if (t.length > 0) text = t
        return
      }
      if (timedOut) return
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
    }

    let agent: Agent
    let unsubscribe: () => void
    try {
      agent = new Agent({
        initialState: {
          systemPrompt: role.systemPrompt,
          model: deps.model,
          thinkingLevel: 'low',
          tools: toolsForRole(role, deps.getTools()),
        },
        streamFn: deps.streamFn,
        toolExecution: 'sequential',
        beforeToolCall,
      })
      unsubscribe = agent.subscribe(onEvent)
    } catch (e) {
      // ★ 有 started 就必须有 ended：构造失败（白名单断言、模型对象异常）也要收口
      const msg = (e as Error).message
      deps.onEvent({ type: 'ended', id, role: role.id, ok: false, steps, tokens, summary: '' })
      return { id, role: role.id, ok: false, steps, tokens, text: '', error: msg }
    }

    const timer = setTimeout(() => {
      timedOut = true
      agent.abort()
    }, timeoutMs)

    // ★ 子体是独立 Agent：主 Agent 的 abort() 管不到它，必须单独注册停止钩子
    const unregisterAbort = deps.registerAbort?.(() => {
      externalStop = true
      agent.abort()
    })

    try {
      await agent.prompt(taskMessage(req))
    } catch (e) {
      // 超时也会走到这里（abort），交给下面的 timedOut 分支统一处理
      if (!timedOut) error = (e as Error).message
    } finally {
      clearTimeout(timer)
      unsubscribe()
      unregisterAbort?.()
    }

    if (externalStop) {
      error = '运行已停止'
    } else if (timedOut) {
      error = `子任务超时（${timeoutMs}ms）`
    } else if (error === null) {
      const stateError = agent.state.errorMessage
      if (typeof stateError === 'string' && stateError.length > 0) error = stateError
    }
    if (error === null && limitReason !== null) error = limitReason

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
