import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { resumeSession, startSession } from '../agent/run-service.js'
import {
  listSessions,
  readLegacySession,
  readSessionEvents,
  readSessionMeta,
  removeSession,
  renameSession,
} from '../agent/session-store.js'
import { getContext } from '../services/context.js'

export const sessionRoutes = new Hono()

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) ? parsed : fallback
}

sessionRoutes.get('/agent/sessions', async (c) => {
  const { root } = getContext()
  const limit = Math.max(1, num(c.req.query('limit'), 50))
  return c.json({ sessions: (await listSessions(root)).slice(0, limit) })
})

sessionRoutes.get('/agent/sessions/:id', async (c) => {
  const { root } = getContext()
  const id = c.req.param('id')
  const meta = id.startsWith('lg_')
    ? await readLegacySession(root, id.slice('lg_'.length))
    : await readSessionMeta(root, id)
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
  const limit = num(c.req.query('limit'), 2000)
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
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''
  if (goal.length === 0) throw new InkloomError('INVALID_INPUT', 'goal 不能为空')
  const mode = body?.mode === 'resume' || body?.mode === 'replan' ? body.mode : 'new'
  return c.json(await startSession(goal, mode))
})

sessionRoutes.post('/agent/sessions/:id/messages', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text.length === 0) throw new InkloomError('INVALID_INPUT', '消息不能为空')
  return c.json({ run: await resumeSession(c.req.param('id'), text) })
})
