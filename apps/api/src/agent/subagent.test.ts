import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubagentRunner, type SubagentEvent } from './subagent.js'

interface FakeAgentLike {
  opts: {
    initialState: { systemPrompt: string; tools: { name: string }[] }
    beforeToolCall?: () => Promise<
      { block?: boolean; terminate?: boolean; reason?: string } | undefined
    >
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
    const agent = h.agents[0] as unknown as {
      opts: { initialState: { tools: { name: string }[] } }
    }
    expect(agent.opts.initialState.tools.map((t) => t.name)).toEqual(['web_search'])
  })

  it('★ 子体步数触顶 → block + terminate，主步数同步累加', async () => {
    const d = deps()
    await d.run({ role: 'stylist', task: 'x' })
    const agent = h.agents[0] as unknown as FakeAgentLike
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
    const agent = h.agents[0] as unknown as FakeAgentLike
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
