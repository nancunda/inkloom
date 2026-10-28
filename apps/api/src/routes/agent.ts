import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  type AgentStreamEvent,
  getAgentRun,
  resumeAgentRun,
  reviewAgentRun,
  sendAgentMessage,
  startAgentRun,
  stopAgentRun,
  subscribeAgentRun,
} from '../agent/run-service.js'
import { getContext } from '../services/context.js'
import { loadPlan, readCurrentPlan } from '../storage/plans.js'

const DEFAULT_GOAL =
  '从零开始搭这本书：先给我一份计划（世界、人物、故事、第 1 章正文），我批准后你按计划逐个任务执行，需要我拍板的地方停下来。'

export const agentRoutes = new Hono()

agentRoutes.post('/agent/runs', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    goal?: unknown
    mode?: unknown
  } | null
  const raw = body?.goal
  const goal = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_GOAL
  const mode =
    body?.mode === 'new' || body?.mode === 'resume' || body?.mode === 'replan'
      ? body.mode
      : undefined
  const run = await startAgentRun(goal, mode === undefined ? {} : { mode })
  return c.json({ run })
})

/**
 * 当前计划（从磁盘读，不依赖内存里的 run）。
 * ★ run 被回收/服务重启后，界面靠它继续显示计划与恢复入口。
 */
agentRoutes.get('/agent/plan', async (c) => {
  const { root } = getContext()
  const id = await readCurrentPlan(root)
  const plan = id === null ? null : await loadPlan(root, id)
  return c.json({ plan })
})

agentRoutes.get('/agent/runs/:id', (c) => {
  const run = getAgentRun(c.req.param('id'))
  if (run === null)
    throw new InkloomError('NOT_FOUND', '这个 agent run 不存在（服务重启后旧 run 不保留）')
  return c.json({ run })
})

agentRoutes.post('/agent/runs/:id/stop', (c) => {
  return c.json({ run: stopAgentRun(c.req.param('id')) })
})

agentRoutes.post('/agent/runs/:id/review', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    decision?: unknown
    feedback?: unknown
  } | null
  const decision = body?.decision
  if (decision !== 'approve' && decision !== 'revise' && decision !== 'skip') {
    throw new InkloomError('INVALID_INPUT', 'decision 只能是 approve、revise 或 skip')
  }
  const feedback = typeof body?.feedback === 'string' ? body.feedback : null
  const run = await reviewAgentRun(c.req.param('id'), decision, feedback)
  return c.json({ run })
})

agentRoutes.post('/agent/runs/:id/messages', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text.length === 0) throw new InkloomError('INVALID_INPUT', '消息不能为空')
  return c.json({ run: sendAgentMessage(c.req.param('id'), text) })
})

/** 预算耗尽/失败后：作者点「继续执行」，恢复被标成 aborted 的计划 */
agentRoutes.post('/agent/runs/:id/resume', (c) => {
  return c.json({ run: resumeAgentRun(c.req.param('id')) })
})

agentRoutes.get('/agent/runs/:id/events', (c) => {
  const id = c.req.param('id')
  const run = getAgentRun(id)
  if (run === null)
    throw new InkloomError('NOT_FOUND', '这个 agent run 不存在（服务重启后旧 run 不保留）')

  return streamSSE(c, async (stream) => {
    let closed = false
    let replaying = true
    let lastSeq = 0
    const buffered: AgentStreamEvent[] = []

    const write = async (e: AgentStreamEvent): Promise<void> => {
      if (closed) return
      await stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
    }

    const unsubscribe = subscribeAgentRun(id, (e) => {
      if (closed) return
      if (replaying) buffered.push(e)
      else void write(e)
    })
    stream.onAbort(() => {
      closed = true
      unsubscribe()
    })

    // 先回放内存里的时间线，再补上回放期间新产生的事件
    for (const e of run.events) {
      await write(e)
      lastSeq = e.seq
    }
    replaying = false
    for (const e of buffered) {
      if (e.seq > lastSeq) await write(e)
    }

    while (!closed) {
      await stream.sleep(15_000)
      if (closed) break
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'ping',
          seq: 0,
          at: new Date().toISOString(),
          // 前端按 `${runId}:${seq}` 去重：心跳没有 runId 会与真事件撞键
          runId: id,
        }),
      })
    }
  })
})
