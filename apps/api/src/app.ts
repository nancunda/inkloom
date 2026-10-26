import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { type ActionDeps, createActions } from './routes/actions.js'
import { checkpoints } from './routes/checkpoints.js'
import { elements } from './routes/elements.js'
import { toApiError } from './routes/errors.js'
import { read } from './routes/read.js'
import { settings } from './routes/settings.js'

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
  app.route('/api', elements)
  app.route('/api', checkpoints)
  app.route('/api', settings)
  app.route('/api', createActions(deps))

  // ★ 生产模式单进程：同一端口同时服务 API 与前端。
  //   发行包的用户只双击一个 start.bat，不该再让他起 Vite。
  //   开发时前端在 5173，这里找不到 dist 就自动跳过。
  const webDist =
    deps.webDist ?? process.env['INKLOOM_WEB_DIST'] ?? join(import.meta.dirname, '../../web/dist')
  if (existsSync(webDist)) {
    app.use('*', serveStatic({ root: webDist }))
    // SPA fallback：非 /api 的未知路径回 index.html（前端路由），
    // /api 的未知路径仍走 404 JSON，不能把接口错误变成一张 HTML 页面。
    app.get('*', (c, next) => {
      if (c.req.path.startsWith('/api/')) return next()
      return serveStatic({ path: 'index.html', root: webDist })(c, next)
    })
  }

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
