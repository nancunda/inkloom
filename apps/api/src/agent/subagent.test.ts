import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubagentRunner, type SubagentEvent } from './subagent.js'

interface FakeAgentOpts {
  initialState: { systemPrompt: string; tools: { name: string }[] }
  beforeToolCall?: (
    ctx: unknown,
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; terminate?: boolean; reason?: string } | undefined>
}

interface FakeAgentLike {
  opts: FakeAgentOpts
  state: { errorMessage?: string }
  listeners: ((e: unknown) => void)[]
  prompts: string[]
}

const h = vi.hoisted(() => ({
  agents: [] as unknown[],
  script: [] as unknown[],
  throwOnPrompt: null as Error | null,
  stateError: null as string | null,
  hang: false,
  aborts: 0,
  callToolCalls: 0,
}))

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgent {
    opts: FakeAgentOpts
    state: { errorMessage?: string } = {}
    listeners: ((e: unknown) => void)[] = []
    prompts: string[] = []
    private abortResolve: (() => void) | null = null

    constructor(opts: FakeAgentOpts) {
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
      if (h.stateError !== null) this.state.errorMessage = h.stateError
      if (h.hang) {
        await new Promise<void>((resolve) => {
          this.abortResolve = resolve
        })
        return
      }
      for (const e of h.script) for (const l of this.listeners) l(e)
      // 模拟 loop 内的工具调用：直到 hook 返回 terminate 才停
      for (let i = 0; i < h.callToolCalls; i += 1) {
        const r = await this.opts.beforeToolCall?.(undefined, undefined)
        if (r?.terminate === true) break
      }
    }

    abort(): void {
      h.aborts += 1
      this.abortResolve?.()
    }
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
    h.stateError = null
    h.hang = false
    h.aborts = 0
    h.callToolCalls = 0
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
    // 前端卡片靠 ended.error 区分「完成」与「未跑完」
    expect(ended.error).toBeNull()
  })

  it('★ 子体工具集被白名单裁剪：没有 write_element / delegate', async () => {
    const d = deps()
    await d.run({ role: 'researcher', task: 'x' })
    const agent = h.agents[0] as unknown as {
      opts: { initialState: { tools: { name: string }[] } }
    }
    expect(agent.opts.initialState.tools.map((t) => t.name)).toEqual(['web_search'])
  })

  it('★ 子体步数触顶 → block + terminate，主步数同步累加', async () => {
    const d = deps()
    await d.run({ role: 'stylist', task: 'x' })
    const agent = h.agents[0] as unknown as FakeAgentLike
    const call = () => agent.opts.beforeToolCall?.(undefined, undefined)
    for (let i = 0; i < 8; i += 1) expect(await call()).toBeUndefined()
    const blocked = await call()
    expect(blocked).toMatchObject({ block: true, terminate: true })
    expect(d.budget.steps).toBe(8)
  })

  it('★ 步数触顶后结束 → ok=false，原因是上限（不能报成功但空结论）', async () => {
    h.callToolCalls = 9
    const d = deps()
    const r = await d.run({ role: 'stylist', task: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('子任务步数上限（8 步）')
    expect(d.budget.steps).toBe(8)
    expect(d.events.map((e) => e.type)).toEqual(['started', 'ended'])
    const ended = d.events[1] as Extract<SubagentEvent, { type: 'ended' }>
    expect(ended.error).toBe('子任务步数上限（8 步）')
  })

  it('★ 触顶但已有结论 → ok=true + partial，不再当失败丢掉结论', async () => {
    h.callToolCalls = 9
    h.script = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '查到三条：一驿三十里' }],
          usage: { input: 10, output: 5 },
        },
      },
    ]
    const d = deps()
    const r = await d.run({ role: 'stylist', task: 'x' })
    expect(r.ok).toBe(true)
    expect(r.partial).toBe(true)
    expect(r.error).toBe('子任务步数上限（8 步）')
    expect(r.text).toContain('一驿三十里')
    const ended = d.events.find((e) => e.type === 'ended') as Extract<
      SubagentEvent,
      { type: 'ended' }
    >
    expect(ended.ok).toBe(true)
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

  it('★ 主预算用尽 → 第一个工具调用就被挡', async () => {
    const d = deps()
    d.budget.steps = 80
    await d.run({ role: 'researcher', task: 'x' })
    const agent = h.agents[0] as unknown as FakeAgentLike
    expect(await agent.opts.beforeToolCall?.(undefined, undefined)).toMatchObject({
      block: true,
      terminate: true,
      reason: expect.stringContaining('步数预算已用尽'),
    })
  })

  it('★ abort 已发生 → 不再扣步（调用不会执行）', async () => {
    const d = deps()
    await d.run({ role: 'researcher', task: 'x' })
    const agent = h.agents[0] as unknown as FakeAgentLike
    const ac = new AbortController()
    ac.abort()
    expect(await agent.opts.beforeToolCall?.(undefined, ac.signal)).toBeUndefined()
    expect(d.budget.steps).toBe(0)
  })

  it('★ prompt 抛错 → ok=false 且不向调用方抛', async () => {
    h.throwOnPrompt = new Error('模型调用失败')
    const d = deps()
    const r = await d.run({ role: 'critic', task: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('模型调用失败')
    expect(d.events.map((e) => e.type)).toEqual(['started', 'ended'])
  })

  it('★ 错误写在 state.errorMessage 时也算失败', async () => {
    h.stateError = '模型挂了'
    const d = deps()
    const r = await d.run({ role: 'critic', task: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('模型挂了')
  })

  it('★ 超时 → abort 一次、ok=false、事件成对', async () => {
    vi.useFakeTimers()
    try {
      h.hang = true
      const d = deps()
      const pending = d.run({ role: 'researcher', task: 'x' })
      await vi.advanceTimersByTimeAsync(60)
      const r = await pending
      expect(r.ok).toBe(false)
      expect(r.error).toBe('子任务超时（50ms）')
      expect(h.aborts).toBe(1)
      expect(d.events.map((e) => e.type)).toEqual(['started', 'ended'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 超长文本截断到 6000 并标注原长', async () => {
    h.script = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(6100) }] },
      },
    ]
    const r = await deps().run({ role: 'critic', task: 'x' })
    expect(r.text.startsWith('a'.repeat(6000))).toBe(true)
    expect(r.text.endsWith('…（共 6100 字符）')).toBe(true)
  })

  it('★ 非法角色 → 不抛、不发事件、不计数', async () => {
    const d = deps()
    const r = await d.run({ role: 'writer' as never, task: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('未知角色 writer')
    expect(d.events).toHaveLength(0)
    expect(d.budget.subagentCalls).toBe(0)
  })

  it('★ 外部停止 → abort 子体、ok=false、原因不写成超时', async () => {
    h.hang = true
    const holder: { stop: (() => void) | null } = { stop: null }
    const budget = { steps: 0, maxSteps: 80, subagentCalls: 0 }
    const events: SubagentEvent[] = []
    const run = createSubagentRunner({
      model: {} as never,
      streamFn: (() => undefined) as never,
      getTools: () => [],
      budget,
      onEvent: (e) => events.push(e),
      onTokens: () => undefined,
      registerAbort: (fn) => {
        holder.stop = fn
        return () => {
          holder.stop = null
        }
      },
      timeoutMs: 50,
    })
    const pending = run({ role: 'researcher', task: 'x' })
    await new Promise((r) => setTimeout(r, 0))
    holder.stop?.()
    const r = await pending
    expect(r.ok).toBe(false)
    expect(r.error).toBe('运行已停止')
    expect(h.aborts).toBe(1)
    expect(events.map((e) => e.type)).toEqual(['started', 'ended'])
  })
})
