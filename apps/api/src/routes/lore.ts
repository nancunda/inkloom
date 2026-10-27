import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { getContext } from '../services/context.js'
import { approveLore, deleteLore, listLore } from '../services/lore-service.js'

/**
 * 资料卡：Agent 搜到/抓到的外部材料。
 *
 * ★ 默认未批准：只有批准过的卡才能跨会话被 read_lore 读到，
 *   否则「联网搜来的内容」会绕过作者对设定的把关直接进 prompt。
 */
export const loreRoutes = new Hono()

loreRoutes.get('/lore', async (c) => {
  const { db, project } = getContext()
  const approvedRaw = c.req.query('approved')
  const q = c.req.query('q')?.trim()
  const limitRaw = Number(c.req.query('limit') ?? '50')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50
  const items = await listLore(db, project.id, {
    ...(approvedRaw === '1' ? { approved: true } : {}),
    ...(approvedRaw === '0' ? { approved: false } : {}),
    ...(q === undefined || q.length === 0 ? {} : { q }),
    limit,
  })
  return c.json({ items })
})

loreRoutes.post('/lore/:id/approve', async (c) => {
  const { db } = getContext()
  const row = await approveLore(db, c.req.param('id')).catch(() => null)
  if (row === null) throw new InkloomError('NOT_FOUND', '资料卡不存在')
  return c.json(row)
})

loreRoutes.delete('/lore/:id', async (c) => {
  const { db } = getContext()
  try {
    await deleteLore(db, c.req.param('id'))
    return c.json({ ok: true })
  } catch (e) {
    const msg = (e as Error).message
    // ★ 404 与 400 必须分开：卡片不存在是 404，已批准不可删是 400（能修的是作者操作）
    if (msg === 'NOT_FOUND') throw new InkloomError('NOT_FOUND', '资料卡不存在')
    throw new InkloomError('INVALID_INPUT', msg)
  }
})
