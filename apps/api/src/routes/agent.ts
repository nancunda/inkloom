import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  type AgentStreamEvent,
  getAgentRun,
  reviewAgentRun,
  startAgentRun,
  stopAgentRun,
  subscribeAgentRun,
} from '../agent/run-service.js'

const DEFAULT_GOAL =
  '从零搭建这本书：世界观、力量体系、人物、关系、卷、蓝图，然后写第 1 章并生成主角形象图。每个阶段结束都停下来等我审阅。'

export const agentRoutes = new Hono()

agentRoutes.post('/agent/runs', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { goal?: unknown } | null
  const raw = body?.goal
  const goal = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_GOAL
  const run = await startAgentRun(goal)
  return c.json({ run })
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
  if (decision !== 'approve' && decision !== 'revise') {
    throw new InkloomError('INVALID_INPUT', 'decision 只能是 approve 或 revise')
  }
  const feedback = typeof body?.feedback === 'string' ? body.feedback : null
  const run = await reviewAgentRun(c.req.param('id'), decision, feedback)
  return c.json({ run })
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
        data: JSON.stringify({ type: 'ping', seq: 0, at: new Date().toISOString() }),
      })
    }
  })
})
