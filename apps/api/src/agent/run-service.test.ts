import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeEvent {
  type: string
}

interface FakeTool {
  name: string
  execute: (id: string, params: unknown) => Promise<unknown>
}

interface FakeAgent {
  opts: { initialState: { tools: FakeTool[] } }
  state: { errorMessage?: string }
  promptCalls: number
  steers: string[]
  fail: () => void
  emit: (e: FakeEvent) => void
}

// vi.mock 工厂会被提升到 import 之前，共享状态必须用 vi.hoisted 创建
const h = vi.hoisted(() => ({
  root: '',
  agents: [] as FakeAgent[],
}))

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgentImpl {
    opts: { initialState: { tools: FakeTool[] } }
    state: { errorMessage?: string } = {}
    promptCalls = 0
    steers: string[] = []
    listeners: ((e: FakeEvent) => void)[] = []
    resolvers: (() => void)[] = []
    rejecters: ((e: Error) => void)[] = []

    constructor(opts: { initialState: { tools: FakeTool[] } }) {
      this.opts = opts
      h.agents.push(this as unknown as FakeAgent)
    }

    subscribe(cb: (e: FakeEvent) => void): () => void {
      this.listeners.push(cb)
      return () => {
        this.listeners = this.listeners.filter((l) => l !== cb)
      }
    }

    /** 永不主动 resolve：测试自己控制「模型还在跑」与「运行结束」的时序 */
    prompt(): Promise<void> {
      this.promptCalls += 1
      return new Promise<void>((resolve, reject) => {
        this.resolvers.push(resolve)
        this.rejecters.push(reject)
      })
    }

    fail(): void {
      const reject = this.rejecters.pop()
      reject?.(new Error('模型调用失败'))
    }

    abort(): void {
      const resolve = this.resolvers.pop()
      resolve?.()
    }

    steer(message: { content: unknown }): void {
      this.steers.push(String(message.content))
    }

    emit(e: FakeEvent): void {
      for (const l of this.listeners) l(e)
    }
  }
  return { Agent: FakeAgentImpl }
})

vi.mock('../services/context.js', () => ({
  getContext: () => ({
    root: h.root,
    project: {
      id: 'proj_unit',
      folderId: 'folder_unit',
      rootPath: h.root,
      name: '测试书',
      genre: '玄幻',
      status: 'writing',
    },
  }),
}))

const { getAgentRun, reviewAgentRun, sendAgentMessage, startAgentRun, stopAgentRun } = await import(
  './run-service.js'
)

function lastAgent(): FakeAgent {
  const agent = h.agents.at(-1)
  if (agent === undefined) throw new Error('没有创建 Agent')
  return agent
}

function findTool(agent: FakeAgent, name: string): FakeTool {
  const tool = agent.opts.initialState.tools.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`找不到工具 ${name}`)
  return tool
}

/** 让 request_review 落进 gateBox，再由 agent_end 把 run 切到等待审阅 */
async function reachGate(stage: 'world' | 'cast' | 'arcs' | 'draft'): Promise<{
  id: string
  agent: FakeAgent
}> {
  const started = await startAgentRun('测试目标')
  const agent = lastAgent()
  await findTool(agent, 'request_review').execute('call_1', {
    stage,
    summary: `${stage} 阶段完成`,
    artifacts: ['world/rules.json'],
  })
  agent.emit({ type: 'agent_end' })
  expect(getAgentRun(started.id)?.status).toBe('waiting_review')
  return { id: started.id, agent }
}

beforeEach(async () => {
  h.agents.length = 0
  h.root = await mkdtemp(join(tmpdir(), 'inkloom-agent-unit-'))
  process.env['DEEPSEEK_API_KEY'] = 'sk-test'
})

afterEach(async () => {
  delete process.env['DEEPSEEK_API_KEY']
  await new Promise((r) => setTimeout(r, 20))
  await rm(h.root, { recursive: true, force: true }).catch(() => undefined)
})

describe('reviewAgentRun 状态机', () => {
  // 回归：2026-10 实测「通过开篇」后又弹了一次 draft 门禁，
  // 因为 approve 一律当成“继续下一阶段”，而 draft 已是最后一站。
  it('★ draft 通过 = 本轮结束，不再续跑', async () => {
    const { id, agent } = await reachGate('draft')

    const reviewed = await reviewAgentRun(id, 'approve', null)

    expect(reviewed.status).toBe('done')
    expect(reviewed.gate).toBeNull()
    expect(reviewed.finishedAt).not.toBeNull()
    expect(agent.promptCalls).toBe(1)
    const types = reviewed.events.map((e) => e.type)
    expect(types).toContain('gate.waiting')
    expect(types).toContain('gate.resolved')
    expect(types).toContain('run.finished')
    expect(types).not.toContain('run.failed')
  })

  it('非 draft 阶段通过后继续下一阶段', async () => {
    const { id, agent } = await reachGate('world')

    const reviewed = await reviewAgentRun(id, 'approve', null)

    expect(reviewed.status).toBe('running')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('draft 打回后带上意见继续跑', async () => {
    const { id, agent } = await reachGate('draft')

    const reviewed = await reviewAgentRun(id, 'revise', '第二章的钩子不够狠')

    expect(reviewed.status).toBe('running')
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('不在等待审阅时拒绝 review', async () => {
    const started = await startAgentRun('测试目标')
    await expect(reviewAgentRun(started.id, 'approve', null)).rejects.toThrow(
      '这个 run 现在不在等待审阅',
    )
    stopAgentRun(started.id)
  })

  it('打回必须带意见', async () => {
    const { id } = await reachGate('cast')
    await expect(reviewAgentRun(id, 'revise', '  ')).rejects.toThrow('打回必须写清楚要改什么')
    stopAgentRun(id)
  })
})

describe('sendAgentMessage（对话式共创）', () => {
  it('运行中发消息 → steer 到当前轮之后', async () => {
    const started = await startAgentRun('测试目标')
    const agent = lastAgent()

    const next = sendAgentMessage(started.id, '顺便把地点名字改短一点')

    expect(next.status).toBe('running')
    expect(agent.steers).toEqual(['顺便把地点名字改短一点'])
    expect(next.events.some((e) => e.type === 'user.message')).toBe(true)
    stopAgentRun(started.id)
  })

  it('★ 等待审阅时发消息 = 带意见打回，本阶段重做', async () => {
    const { id, agent } = await reachGate('world')

    const next = sendAgentMessage(id, '规则太多，压到三条')

    expect(next.status).toBe('running')
    expect(next.gate).toBeNull()
    expect(agent.promptCalls).toBe(2)
    const resolved = next.events.find((e) => e.type === 'gate.resolved')
    expect(resolved).toMatchObject({ decision: 'revise', feedback: '规则太多，压到三条' })
    stopAgentRun(id)
  })

  it('★ 本轮结束后还能接着聊（同一段 transcript）', async () => {
    const { id, agent } = await reachGate('draft')
    await reviewAgentRun(id, 'approve', null)
    expect(getAgentRun(id)?.status).toBe('done')

    const next = sendAgentMessage(id, '第 2 场再克制一点')

    expect(next.status).toBe('running')
    expect(next.finishedAt).toBeNull()
    expect(agent.promptCalls).toBe(2)
    stopAgentRun(id)
  })

  it('失败的 run 不再接收消息', async () => {
    const started = await startAgentRun('测试目标')
    lastAgent().fail()
    await new Promise((r) => setTimeout(r, 10))
    expect(getAgentRun(started.id)?.status).toBe('failed')

    expect(() => sendAgentMessage(started.id, '继续')).toThrow('这个 run 失败了，请开新会话')
  })
})
