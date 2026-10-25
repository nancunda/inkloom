import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { commitAll, initRepo, isRepo } from './git/runner.js'
import { openBookIndexDb } from './index-db/open-book.js'
import { setContext } from './services/context.js'
import { openProject } from './storage/project.js'

export interface RunningServer {
  /** 实际监听的端口（传 0 时由系统分配） */
  port: number
  close: () => Promise<void>
}

/**
 * 启动 HTTP 服务（单书模式，Ruling 45）。
 *
 * ★ 单书：整进程只设一次 context。切换书要重启——
 *   换来的是不用改造 12 个 service 的签名。
 * ★ 返回句柄而不是 void：验收脚本要能关掉它，
 *   否则进程挂在那里不退。port 传 0 则随机分配，不撞端口。
 */
export async function startServer(opts: {
  bookDir: string
  port?: number
}): Promise<RunningServer> {
  const bookDir = resolve(opts.bookDir)
  if (!existsSync(bookDir)) {
    throw new Error(`书籍目录不存在：${bookDir}`)
  }

  const opened = await openProject(bookDir)
  const db = await openBookIndexDb(bookDir)
  await setContext({ root: bookDir, db, project: opened.project })

  // ★ 仓库里的示例书不带 .git（嵌套仓库不能入库），
  //   而 accept / finalize 都会 commit——不补这一下，
  //   新 clone 的用户第一次点「接受」就吃 GIT_FAILED。
  if (!(await isRepo(bookDir))) {
    await initRepo(bookDir)
    await commitAll(bookDir, 'chore: 初始化书籍仓库（首次启动）')
    console.log('  ✓ 已为这本书初始化 Git 仓库')
  }

  const wanted = opts.port ?? 8787
  const server = serve({ fetch: createApp().fetch, port: wanted })
  if (!server.listening) {
    await new Promise<void>((ok) => server.once('listening', () => ok()))
  }
  const port = (server.address() as AddressInfo).port

  console.log(`✓ inkloom API  http://localhost:${port}`)
  console.log(`  书          ${opened.project.name}（${bookDir}）`)
  // ★ 只绑本机的话应该用 127.0.0.1；@hono/node-server 默认 0.0.0.0。
  //   这里提示一句，避免在公共网络上裸奔却不自知。
  console.log('  ⚠ 监听 0.0.0.0，同一局域网内可访问（无鉴权，仅供本机使用）')

  return {
    port,
    close: () =>
      new Promise<void>((ok, fail) =>
        server.close((e) => (e === undefined || e === null ? ok() : fail(e))),
      ),
  }
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
