import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { openBookIndexDb } from './index-db/open-book.js'
import { setContext } from './services/context.js'
import { openProject } from './storage/project.js'

/**
 * 启动 HTTP 服务（单书模式，Ruling 45）。
 *
 * ★ 单书：整进程只设一次 context。切换书要重启——
 *   换来的是不用改造 12 个 service 的签名。
 */
export async function startServer(opts: { bookDir: string; port?: number }): Promise<void> {
  const bookDir = resolve(opts.bookDir)
  if (!existsSync(bookDir)) {
    throw new Error(`书籍目录不存在：${bookDir}`)
  }

  const opened = await openProject(bookDir)
  const db = await openBookIndexDb(bookDir)
  await setContext({ root: bookDir, db, project: opened.project })

  const port = opts.port ?? 8787
  serve({ fetch: createApp().fetch, port })
  console.log(`✓ inkloom API  http://localhost:${port}`)
  console.log(`  书          ${opened.project.name}（${bookDir}）`)
  // ★ 只绑本机的话应该用 127.0.0.1；@hono/node-server 默认 0.0.0.0。
  //   这里提示一句，避免在公共网络上裸奔却不自知。
  console.log('  ⚠ 监听 0.0.0.0，同一局域网内可访问（无鉴权，仅供本机使用）')
}

// 直接用 `pnpm api` 启动时才跑（被 import 时不跑）
if (process.argv[1]?.replace(/\\/g, '/').endsWith('server.ts') === true) {
  const book = process.env['INKLOOM_BOOK']
  if (book === undefined) {
    console.error('缺少 INKLOOM_BOOK=<书籍目录>，例如：INKLOOM_BOOK=fixtures/qixia pnpm api')
    process.exit(1)
  }
  await startServer({ bookDir: book, port: Number(process.env['PORT'] ?? 8787) })
}
