import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { readLastBook, resolveLibraryRoot } from './library/library.js'
import { openBookAt } from './library/open-book.js'
import { closeContext, peekContext } from './services/context.js'

export interface RunningServer {
  /** 实际监听的端口（传 0 时由系统分配） */
  port: number
  /** 内核实际绑定到的地址，验收脚本用它确认没有绑 0.0.0.0 */
  address: string
  close: () => Promise<void>
}

/**
 * 启动 HTTP 服务。
 *
 * ★ 书库模式：`libraryRoot` 下每个一级目录是一本书；启动时可以显式给
 *   `bookDir`（兼容 INKLOOM_BOOK），否则恢复上次打开的书；都没有就空态，
 *   由前端书库页选择/新建。
 * ★ 单书 context 仍然保留：同一时刻只打开一本，切书走 /api/library/open。
 * ★ 返回句柄而不是 void：验收脚本要能关掉它，否则进程挂在那里不退。
 */
export async function startServer(opts: {
  libraryRoot?: string
  bookDir?: string
  port?: number
  /** 只在真需要局域网访问时显式传；默认仅本机（spec §9.9） */
  hostname?: string
}): Promise<RunningServer> {
  const libraryRoot = resolve(opts.libraryRoot ?? resolveLibraryRoot())
  await mkdir(libraryRoot, { recursive: true })

  // 显式 bookDir 优先；否则恢复上次打开的书（目录还在才恢复）
  let target: string | null = null
  if (opts.bookDir !== undefined && opts.bookDir.trim().length > 0) {
    target = resolve(opts.bookDir)
    if (!existsSync(target)) throw new Error(`书籍目录不存在：${target}`)
  } else {
    const last = await readLastBook()
    if (last !== null && existsSync(last)) target = last
  }

  if (target !== null) {
    try {
      const opened = await openBookAt(target)
      for (const note of opened.notes) console.log(`  ✓ ${note}`)
    } catch (e) {
      // 上次的书坏了/被删了：降级到空态，不要因此起不来
      console.warn(`  ⚠ 打开上次的书失败，进入书库空态：${(e as Error).message}`)
    }
  }

  const wanted = opts.port ?? 8787
  // ★ 默认 127.0.0.1，不是 0.0.0.0（spec §9.9）：API 没有鉴权，
  //   绑全网卡意味着同一个咖啡馆 WiFi 里的人都能读写你的书。
  const hostname = opts.hostname ?? '127.0.0.1'
  const server = serve({ fetch: createApp().fetch, port: wanted, hostname })
  if (!server.listening) {
    await new Promise<void>((ok) => server.once('listening', () => ok()))
  }
  const addr = server.address() as AddressInfo
  const port = addr.port

  const current = peekContext()
  console.log(`✓ inkloom API  http://${hostname}:${port}`)
  console.log(`  书库        ${libraryRoot}`)
  console.log(
    current === null
      ? '  当前书      未打开（浏览器里从书库选择或新建）'
      : `  当前书      ${current.project.name}（${current.root}）`,
  )
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    console.log(`  ⚠ 监听 ${hostname}，局域网内可访问（无鉴权，谨慎使用）`)
  }

  return {
    port,
    address: addr.address,
    close: async () => {
      await new Promise<void>((ok, fail) =>
        server.close((e) => (e === undefined || e === null ? ok() : fail(e))),
      )
      // 连接也是这里打开的，close 时必须一起还回去：
      // Windows 上被句柄钉住的 index.sqlite 删不掉（EBUSY）。
      await closeContext()
    },
  }
}

// 直接用 `pnpm api` 启动时才跑（被 import 时不跑）
if (process.argv[1]?.replace(/\\/g, '/').endsWith('server.ts') === true) {
  const book = process.env['INKLOOM_BOOK']?.trim()
  await startServer({
    libraryRoot: resolveLibraryRoot(),
    ...(book === undefined || book.length === 0 ? {} : { bookDir: book }),
    port: Number(process.env['PORT'] ?? 8787),
    ...(process.env['HOST'] === undefined ? {} : { hostname: process.env['HOST'] }),
  })
}
