import type { EntityType } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { readElement, upsertElement } from '../services/element-service.js'
import { hashContent } from '../storage/atomic-write.js'

/**
 * 要素读写：角色、世界规则、力量体系。
 *
 * ★ 只允许 characters/ 与 world/ 两个目录：这是「人可编辑的设定」边界。
 *   章节正文走专门的场景接口（段协议 + 版本），不能从这里直写。
 * ★ 写入复用 upsertElement：CAS 校验、revision、索引、git commit 一次到位——
 *   前端保存与 CLI `element set` 走的是同一条路。
 */
const READABLE = ['characters/', 'world/']

const TYPES = new Set<string>(['character', 'world_rule', 'power_system', 'power_tier'])

function assertPath(rel: string): void {
  if (!READABLE.some((p) => rel.startsWith(p)) || rel.includes('..')) {
    throw new InkloomError('INVALID_INPUT', 'path 只能是 characters/ 或 world/ 下的文件')
  }
}

export const elements = new Hono()

elements.get('/elements', async (c) => {
  const rel = c.req.query('path') ?? ''
  assertPath(rel)
  const data = await readElement(rel)
  if (data === null) throw new InkloomError('NOT_FOUND', `文件不存在：${rel}`)
  // 与 writeJsonElement 的落盘格式一致，才能和原子写的 CAS 对上
  return c.json({ path: rel, data, hash: hashContent(`${JSON.stringify(data, null, 2)}\n`) })
})

elements.put('/elements', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (body === null) throw new InkloomError('INVALID_INPUT', '请求体必须是 JSON 对象')

  const relPath = typeof body['relPath'] === 'string' ? body['relPath'] : ''
  const entityType = typeof body['entityType'] === 'string' ? body['entityType'] : ''
  const entityId = typeof body['entityId'] === 'string' ? body['entityId'] : ''
  const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined
  const expectedHash = typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined

  assertPath(relPath)
  if (!TYPES.has(entityType))
    throw new InkloomError('INVALID_INPUT', `不支持的 entityType：${entityType}`)
  if (entityId.trim().length === 0) throw new InkloomError('INVALID_INPUT', 'entityId 不能为空')
  if (!('payload' in body)) throw new InkloomError('INVALID_INPUT', '缺少 payload')

  const result = await upsertElement({
    entityType: entityType as EntityType,
    entityId,
    relPath,
    payload: body['payload'],
    changeSource: 'human',
    ...(reason === undefined || reason.length === 0 ? {} : { changeReason: reason }),
    ...(expectedHash === undefined ? {} : { expectedHash }),
  })

  return c.json({ ok: true, path: relPath, ...result })
})
