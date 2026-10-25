import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { type ActionDeps, createActions } from './routes/actions.js'
import { toApiError } from './routes/errors.js'
import { read } from './routes/read.js'

/**
 * 建 Hono 应用。
 *
 * ★ 接收 deps 是为了让 HTTP 层测试能注入假 LLM（见 ActionDeps 的注释）。
 *   生产调用 `createApp()` 不传参数。
 */
export function createApp(deps: ActionDeps = {}): Hono {
  const app = new Hono()

  if (process.env['INKLOOM_HTTP_LOG'] === '1') app.use('*', logger())
  // 开发期前端在 5173，API 在 8787
  app.use('/api/*', cors({ origin: (origin) => origin ?? '*' }))

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.route('/api', read)
  app.route('/api', createActions(deps))

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: '没有这个接口' } }, 404))

  app.onError((err, c) => {
    // Hono 自己的异常（如 body 解析失败）按它带的状态码返回
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'HTTP', message: err.message } }, err.status)
    }
    const { status, body } = toApiError(err)
    // ★ 只给 5xx 打日志：4xx 是用户输入错，不该刷屏
    if (status >= 500) console.error('[api]', err)
    return c.json(body, status)
  })

  return app
}

export const app = createApp()
