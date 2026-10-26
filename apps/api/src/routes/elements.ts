import type { EntityType } from '@inkloom/core'
import { blueprintSchema, InkloomError, locationSchema, routeSchema } from '@inkloom/shared'
import { Hono } from 'hono'
import { getContext } from '../services/context.js'
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

const TYPES = new Set<string>([
  'character',
  'world_rule',
  'power_system',
  'power_tier',
  'location',
  'route',
])

/**
 * 数组型世界文件的校验器。
 *
 * ★ 直接用 shared 里的 Zod schema：前端表单、CLI、提示词加载器读的是同一套
 *   约束（mode 枚举、days 必须正整数），不在 HTTP 层再手写一份 if。
 */
const WORLD_VALIDATORS: Record<
  string,
  { schema: { safeParse: (v: unknown) => SafeParseResult }; label: string }
> = {
  'world/locations.json': { schema: locationSchema.array(), label: '地点' },
  'world/routes.json': { schema: routeSchema.array(), label: '路线' },
}

interface SafeParseResult {
  success: boolean
  data?: unknown
  error?: { issues: { path: PropertyKey[]; message: string }[] }
}

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

  let payload = body['payload']
  const validator = WORLD_VALIDATORS[relPath]
  if (validator !== undefined) {
    // ★ projectId 是身份锚，由服务端补：前端新建一行时不该知道也不该拼它
    const { project } = getContext()
    if (Array.isArray(payload)) {
      payload = payload.map((row) => {
        const r = row as { projectId?: unknown }
        return r.projectId === undefined || r.projectId === ''
          ? { ...(row as Record<string, unknown>), projectId: project.id }
          : row
      })
    }
    const parsed = validator.schema.safeParse(payload)
    if (!parsed.success) {
      const issues = parsed.error?.issues ?? []
      throw new InkloomError(
        'INVALID_INPUT',
        `${validator.label}校验失败：${issues
          .slice(0, 3)
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('；')}`,
      )
    }
    payload = parsed.data
  }

  const result = await upsertElement({
    entityType: entityType as EntityType,
    entityId,
    relPath,
    payload,
    changeSource: 'human',
    ...(reason === undefined || reason.length === 0 ? {} : { changeReason: reason }),
    ...(expectedHash === undefined ? {} : { expectedHash }),
  })

  return c.json({ ok: true, path: relPath, ...result })
})

/**
 * 新建章节蓝图（一章一个文件）。
 *
 * ★ id 与 projectId 由服务端生成：前者是全书唯一标识，后者是身份锚，
 *   都不该由前端拼。章号冲突直接 409，而不是静默覆盖别人的蓝图。
 */
elements.post('/blueprints', async (c) => {
  const { project } = getContext()
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (body === null) throw new InkloomError('INVALID_INPUT', '请求体必须是 JSON 对象')

  const chapterNo = Number(body['chapterNo'])
  if (!Number.isInteger(chapterNo) || chapterNo <= 0) {
    throw new InkloomError('INVALID_INPUT', 'chapterNo 必须是正整数')
  }

  const relPath = `story/blueprints/ch-${String(chapterNo).padStart(3, '0')}.json`
  if ((await readElement(relPath)) !== null) {
    throw new InkloomError('CONFLICT', `第 ${chapterNo} 章的蓝图已存在`)
  }

  const parsed = blueprintSchema.safeParse({
    ...body,
    id: `b${chapterNo}`,
    projectId: project.id,
    chapterNo,
  })
  if (!parsed.success) {
    throw new InkloomError(
      'INVALID_INPUT',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'),
    )
  }

  const result = await upsertElement({
    entityType: 'blueprint',
    entityId: parsed.data.id,
    relPath,
    payload: parsed.data,
    changeSource: 'human',
    changeReason: '界面新建章节蓝图',
  })

  return c.json({ ok: true, chapterNo, relPath, ...result })
})
