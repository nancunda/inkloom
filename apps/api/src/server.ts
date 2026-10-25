import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { commitAll, initRepo, isRepo } from './git/runner.js'
import { openBookIndexDb } from './index-db/open-book.js'
import { setContext } from './services/context.js'
import { openProject } from './storage/project.js'
import { reindex } from './storage/reindex.js'

export interface RunningServer {
  /** 实际监听的端口（传 0 时由系统分配） */
  port: number
  /** 内核实际绑定到的地址，验收脚本用它确认没有绑 0.0.0.0 */
  address: string
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
  /** 只在真需要局域网访问时显式传；默认仅本机（spec §9.9） */
  hostname?: string
}): Promise<RunningServer> {
  const bookDir = resolve(opts.bookDir)
  if (!existsSync(bookDir)) {
    throw new Error(`书籍目录不存在：${bookDir}`)
  }

  const opened = await openProject(bookDir)
  const db = await openBookIndexDb(bookDir)
  // ★ 必须在 setContext 之前数：setContext 会 upsert 一行 Project（外键需要），
  //   数晚了就永远不为空，下面的重建永远不会触发。
  const indexWasEmpty = (await db.project.count()) === 0
  await setContext({ root: bookDir, db, project: opened.project })

  // ★ 索引为空就从文件重建。index.sqlite 在 .gitignore 里（它本就该是可
  //   丢弃的），新 clone 第一次启动时表能建出来但一条数据也没有，
  //   界面会像那样显示：五章全是「计划中」、场景一个都看不见。
  //   「索引可丢弃」的前提是随时能重建——否则它就不是缓存，是命门。
  if (indexWasEmpty) {
    const report = await reindex(bookDir, db)
    console.log(`  ✓ 索引为空，已从文件重建（${report.chapters} 章 / ${report.segments} 段）`)
    for (const w of report.warnings) console.log(`    ⚠ ${w}`)
  }

  // ★ 仓库里的示例书不带 .git（嵌套仓库不能入库），
  //   而 accept / finalize 都会 commit——不补这一下，
  //   新 clone 的用户第一次点「接受」就吃 GIT_FAILED。
  if (!(await isRepo(bookDir))) {
    await initRepo(bookDir)
    await commitAll(bookDir, 'chore: 初始化书籍仓库（首次启动）')
    console.log('  ✓ 已为这本书初始化 Git 仓库')
  }

  const wanted = opts.port ?? 8787
  // ★ 默认 127.0.0.1，不是 0.0.0.0（spec §9.9）：API 没有鉴权，
  //   绑全网卡意味着同一个咖啡馆 WiFi 里的人都能读写你的书。
  //   @hono/node-server 不加 hostname 时恰好会绑 0.0.0.0——必须显式传。
  const hostname = opts.hostname ?? '127.0.0.1'
  const server = serve({ fetch: createApp().fetch, port: wanted, hostname })
  if (!server.listening) {
    await new Promise<void>((ok) => server.once('listening', () => ok()))
  }
  const addr = server.address() as AddressInfo
  const port = addr.port

  console.log(`✓ inkloom API  http://${hostname}:${port}`)
  console.log(`  书          ${opened.project.name}（${bookDir}）`)
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
      // ★ 连接也是 startServer 开的，close 时必须一起还回去：
      //   只关 HTTP 不关库的话，Windows 上那本书的 index.sqlite 被句柄
      //   钉着删不掉（EBUSY），反复启停还会漏连接。
      await db.$disconnect()
    },
  }
}

// 直接用 `pnpm api` 启动时才跑（被 import 时不跑）
if (process.argv[1]?.replace(/\\/g, '/').endsWith('server.ts') === true) {
  const book = process.env['INKLOOM_BOOK']
  if (book === undefined) {
    console.error('缺少 INKLOOM_BOOK=<书籍目录>，例如：INKLOOM_BOOK=fixtures/qixia pnpm api')
    process.exit(1)
  }
  await startServer({
    bookDir: book,
    port: Number(process.env['PORT'] ?? 8787),
    ...(process.env['HOST'] === undefined ? {} : { hostname: process.env['HOST'] }),
  })
}
